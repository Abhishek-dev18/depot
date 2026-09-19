package com.depot.app

import android.Manifest
import android.content.pm.PackageManager
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
import com.depot.app.ui.DepotApp
import com.depot.app.ui.DepotViewModel
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.DepotTheme

class MainActivity : ComponentActivity() {

    private val viewModel: DepotViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
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
                val pickFile = rememberLauncherForActivityResult(
                    ActivityResultContracts.OpenDocument(),
                ) { uri -> uri?.let(viewModel::onFileSelected) }

                Box(Modifier.fillMaxSize().background(DepotColors.Bg)) {
                    DepotApp(
                        state = state,
                        onToggleListening = viewModel::toggleListening,
                        onPickFile = { pickFile.launch(arrayOf("*/*")) },
                        onSignalUrlChange = viewModel::onSignalUrlChange,
                        onPayloadChange = viewModel::onPayloadChange,
                        onLink = viewModel::link,
                        onQrScanned = viewModel::onQrScanned,
                        onApprove = viewModel::onApprove,
                        onReject = viewModel::onReject,
                        onCancelLink = viewModel::cancelLink,
                        onDismissResult = viewModel::dismissResult,
                        onRename = viewModel::onRename,
                        onRevoke = viewModel::onRevoke,
                    )
                }
            }
        }
    }
}
