package com.depot.app

import android.Manifest
import android.content.Intent
import android.content.ContentValues
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import java.io.File
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import com.depot.app.service.ReceivedFile
import com.depot.app.ui.DepotApp
import com.depot.app.ui.DepotViewModel
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.DepotTheme
import com.depot.app.ui.theme.isDark

class MainActivity : ComponentActivity() {

    private val viewModel: DepotViewModel by viewModels()

    /** A share that arrives while the app is already running. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        offerSharedFile(intent)
    }

    /**
     * Another app shared a file with Depot.
     *
     * ACTION_SEND grants this activity read access to that one URI, which
     * is the same shape of permission the file picker hands back: the user
     * chose exactly this file and nothing else. It becomes the single
     * offered file, alongside — not instead of — any granted folders.
     */
    private fun offerSharedFile(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
        uri?.let { viewModel.onFilesSelected(listOf(it)) }
    }

    /**
     * Hands a received file (§5.10) to whatever app the phone would have
     * used for it anyway.
     *
     * Depot does not open other people's files itself — a file server
     * that is also a viewer is a much larger attack surface for no gain,
     * and the phone already knows what to do with a PDF. The read grant
     * is passed along for the one URI and nothing else.
     */
    private fun openReceived(where: String) {
        val uri = shareableUri(where) ?: return
        val view = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, contentResolver.getType(uri) ?: "*/*")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        // No viewer for this type is an ordinary situation, not an error
        // worth crashing over: the file is on the phone either way.
        runCatching { startActivity(view) }
    }

    /**
     * A URI another app is allowed to read.
     *
     * Two kinds of destination end up in [ReceivedFile.where]. A granted
     * folder gives a content URI already, and it is passed on unchanged.
     * The app's own inbox gives a filesystem path, which no other app may
     * open directly — that is the point of private storage — so it goes
     * through the FileProvider, which hands out a temporary grant for
     * that one file.
     */
    private fun shareableUri(where: String): Uri? {
        if (!where.startsWith("/")) return runCatching { Uri.parse(where) }.getOrNull()
        return runCatching {
            FileProvider.getUriForFile(this, "$packageName.files", File(where))
        }.getOrNull()
    }

    /**
     * Copying a received file out of the app and into Downloads — the
     * phone's half of the browser's DOWNLOAD.
     *
     * Straight there, without asking where to put it. A file picker for
     * this is a question with one sensible answer, asked every time, and
     * the browser's DOWNLOAD does not ask it either. Still a deliberate
     * step: until it is taken, a file a Client sent exists only inside
     * this app and uninstalling takes it with it.
     *
     * MediaStore from Android 10 on, which needs no permission because
     * the app only ever writes the row it created. Below that, writing
     * to Downloads needs storage permission the app does not otherwise
     * want, so those versions are handed the picker instead — the same
     * outcome, one more tap, on a shrinking minority of phones.
     */
    private var saving: ReceivedFile? = null

    private fun saveReceived(file: ReceivedFile, pickIfNeeded: () -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            saving = file
            pickIfNeeded()
            return
        }
        val stored = runCatching { saveToDownloads(file) }.getOrNull()
        viewModel.onSavedReceived(file, stored)
    }

    /** Returns what it was called in Downloads, or throws. */
    private fun saveToDownloads(file: ReceivedFile): String {
        val source = shareableUri(file.where ?: error("nothing to save")) ?: error("nothing to save")
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, file.name)
            put(MediaStore.Downloads.MIME_TYPE, contentResolver.getType(source) ?: "application/octet-stream")
            // Marked while it is being written, so nothing else sees a
            // half-copied file — the same rule §5.10 follows on the way in.
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val into = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: error("could not create a file in Downloads")
        try {
            contentResolver.openInputStream(source)?.use { input ->
                contentResolver.openOutputStream(into)?.use { output -> input.copyTo(output) }
            } ?: error("could not read it back")
        } catch (e: Exception) {
            runCatching { contentResolver.delete(into, null, null) }
            throw e
        }
        contentResolver.update(into, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        // MediaStore renames on a collision, as the inbox does.
        return contentResolver.query(into, null, null, null, null)?.use { c ->
            val i = c.getColumnIndex(MediaStore.Downloads.DISPLAY_NAME)
            if (i >= 0 && c.moveToFirst()) c.getString(i) else file.name
        } ?: file.name
    }

    /** The pre-Android-10 path, where the user names the place. */
    private fun saveReceivedTo(file: ReceivedFile, into: Uri?) {
        if (into == null) return
        val source = shareableUri(file.where ?: return) ?: return
        val ok = runCatching {
            contentResolver.openInputStream(source)?.use { input ->
                contentResolver.openOutputStream(into)?.use { output -> input.copyTo(output) }
            }
        }.isSuccess
        viewModel.onSavedReceived(file, if (ok) file.name else null)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        offerSharedFile(intent)
        setContent {
            val state by viewModel.state.collectAsState()
            val dark = state.themePreference.isDark()

            // The status and navigation bar icons follow the app's theme,
            // not only the system's: a phone in dark mode with the app set
            // to light would otherwise draw white icons on a light screen.
            LaunchedEffect(dark) {
                val bars = if (dark) {
                    SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
                } else {
                    SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
                }
                enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
            }

            DepotTheme(dark = dark) {

                // Android 13+ will silently drop the foreground service's
                // notification without this, and a service with no visible
                // notification is one the system is entitled to kill.
                val requestNotifications = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission(),
                ) { }
                LaunchedEffect(Unit) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        val granted = ContextCompat.checkSelfPermission(
                            this@MainActivity,
                            Manifest.permission.POST_NOTIFICATIONS,
                        ) == PackageManager.PERMISSION_GRANTED
                        if (!granted) requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                }

                // The Storage Access Framework hands back a URI the app may
                // read without holding any broad storage permission, which
                // is the right shape for a Depot: the user picks exactly
                // what is shared, nothing more.
                // Several at a time, and each pick adds to what is
                // already on offer rather than replacing it.
                val pickFile = rememberLauncherForActivityResult(
                    ActivityResultContracts.OpenMultipleDocuments(),
                ) { uris -> viewModel.onFilesSelected(uris) }

                // Where a received file goes when the user asks to keep
                // it. The user names the place, which is the consent the
                // writable-folder flag used to stand in for — asked now,
                // about one file, instead of in advance about a folder.
                val pickWhereToSave = rememberLauncherForActivityResult(
                    ActivityResultContracts.CreateDocument("*/*"),
                ) { into ->
                    saving?.let { saveReceivedTo(it, into) }
                    saving = null
                }

                // A whole folder, so a Client has something to browse
                // (protocol.md §5.9). The tree permission is taken
                // persistably in the view model, or the grant would stop
                // working at the next reboot.
                val pickFolder = rememberLauncherForActivityResult(
                    ActivityResultContracts.OpenDocumentTree(),
                ) { uri -> uri?.let(viewModel::onFolderGranted) }

                Box(Modifier.fillMaxSize().background(DepotColors.Bg)) {
                    DepotApp(
                        state = state,
                        onToggleListening = viewModel::toggleListening,
                        onPickFile = { pickFile.launch(arrayOf("*/*")) },
                        onRemoveFile = viewModel::onRemoveOfferedFile,
                        onOpenReceived = { file -> file.where?.let(::openReceived) },
                        onNetworkPreference = viewModel::onNetworkPreference,
                        onThemePreference = viewModel::onThemePreference,
                        onSaveReceived = { file ->
                            saveReceived(file) { pickWhereToSave.launch(file.name) }
                        },
                        onRemoveReceived = viewModel::onRemoveReceived,
                        onClearReceived = viewModel::onClearReceived,
                        onAddFolder = { pickFolder.launch(null) },
                        onToggleGrant = viewModel::onToggleGrant,
                        onToggleGrantWritable = viewModel::onToggleGrantWritable,
                        onForgetGrant = viewModel::onForgetGrant,
                        onSignalUrlChange = viewModel::onSignalUrlChange,
                        onTurnChange = viewModel::onTurnChange,
                        onPayloadChange = viewModel::onPayloadChange,
                        onLink = viewModel::link,
                        onQrScanned = viewModel::onQrScanned,
                        onApprove = viewModel::onApprove,
                        onReject = viewModel::onReject,
                        onCancelLink = viewModel::cancelLink,
                        onDismissResult = viewModel::dismissResult,
                        onRename = viewModel::onRename,
                        onRevoke = viewModel::onRevoke,
                        onForgetDevice = viewModel::onForgetDevice,
                    )
                }
            }
        }
    }
}
