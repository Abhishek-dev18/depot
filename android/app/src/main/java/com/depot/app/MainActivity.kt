package com.depot.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import com.depot.app.ui.PairingScreen
import com.depot.app.ui.PairingViewModel
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.DepotTheme

class MainActivity : ComponentActivity() {

    private val viewModel: PairingViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            DepotTheme {
                val state by viewModel.state.collectAsState()
                Scaffold(
                    modifier = Modifier.fillMaxSize(),
                    containerColor = DepotColors.Bg,
                ) { innerPadding ->
                    PairingScreen(
                        state = state,
                        onPayloadChange = viewModel::onPayloadChange,
                        onJoin = viewModel::join,
                        onApprove = viewModel::onApprove,
                        onRevoke = viewModel::onRevoke,
                        onDismissResult = viewModel::dismissResult,
                        onSignalUrlChange = viewModel::onSignalUrlChange,
                        onToggleListening = viewModel::toggleListening,
                        modifier = Modifier.padding(innerPadding),
                    )
                }
            }
        }
    }
}
