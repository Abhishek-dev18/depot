package com.depot.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
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
import androidx.core.content.IntentCompat
import com.depot.app.ui.DepotApp
import com.depot.app.ui.DepotViewModel
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.DepotTheme

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
        val uri = runCatching { Uri.parse(where) }.getOrNull() ?: return
        val view = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, contentResolver.getType(uri) ?: "*/*")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        // No viewer for this type is an ordinary situation, not an error
        // worth crashing over: the file is on the phone either way.
        runCatching { startActivity(view) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        offerSharedFile(intent)
        setContent {
            DepotTheme {
                val state by viewModel.state.collectAsState()

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
