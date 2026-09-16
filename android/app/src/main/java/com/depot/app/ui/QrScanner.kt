package com.depot.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.util.Log
import androidx.annotation.OptIn
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.MonoStyle
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

private const val TAG = "QrScanner"

/**
 * Reads the Client's pairing QR (protocol.md §3.1).
 *
 * This is the security anchor of the whole protocol: the Client's ephemeral
 * public key reaches the Depot through the camera precisely because Signal
 * cannot touch it there. Scanning is therefore not a convenience over
 * pasting — pasting is the fallback, and the camera is the intended path.
 */
@Composable
fun QrScannerScreen(
    onScanned: (String) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val requestCamera = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
    ) { granted = it }

    LaunchedEffect(Unit) {
        if (!granted) requestCamera.launch(Manifest.permission.CAMERA)
    }

    Box(modifier.fillMaxSize().background(DepotColors.Bg)) {
        if (granted) {
            CameraPreview(onScanned = onScanned)
        } else {
            Column(
                Modifier.fillMaxSize().padding(32.dp),
                verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    "Camera access is needed to read the Client's QR code.",
                    color = DepotColors.Ink2,
                    textAlign = TextAlign.Center,
                )
                Text(
                    "You can paste the payload instead if you would rather not grant it.",
                    color = DepotColors.Ink3,
                    style = MonoStyle.copy(fontSize = 12.sp),
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        }

        // A viewfinder that says where to aim, over the live preview.
        Box(
            Modifier
                .align(Alignment.Center)
                .size(240.dp)
                .border(2.dp, DepotColors.Amber, RoundedCornerShape(16.dp)),
        )

        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                "POINT AT THE CLIENT'S QR CODE",
                color = DepotColors.Ink2,
                style = MonoStyle.copy(fontSize = 11.sp, letterSpacing = 1.sp),
            )
            Button(
                onClick = onCancel,
                modifier = Modifier.padding(top = 12.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = DepotColors.Surface2,
                    contentColor = DepotColors.Ink,
                ),
                shape = RoundedCornerShape(9.dp),
            ) {
                Text("Cancel")
            }
        }
    }
}

@Composable
private fun CameraPreview(onScanned: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val scanner = remember { BarcodeScanning.getClient() }

    // Guards against the analyzer firing again while the caller is still
    // navigating away from this screen.
    val handled = remember { java.util.concurrent.atomic.AtomicBoolean(false) }

    DisposableEffect(Unit) {
        onDispose {
            analysisExecutor.shutdown()
            scanner.close()
        }
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            val previewView = PreviewView(ctx).apply {
                scaleType = PreviewView.ScaleType.FILL_CENTER
            }
            val providerFuture = ProcessCameraProvider.getInstance(ctx)
            providerFuture.addListener({
                runCatching {
                    val provider = providerFuture.get()
                    val preview = Preview.Builder().build().also {
                        it.surfaceProvider = previewView.surfaceProvider
                    }
                    val analysis = ImageAnalysis.Builder()
                        // Dropping stale frames keeps latency low; a QR that
                        // is still in view will simply be read next frame.
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                        .also { it.setAnalyzer(analysisExecutor, qrAnalyzer(scanner, handled, onScanned)) }

                    provider.unbindAll()
                    provider.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        analysis,
                    )
                }.onFailure { Log.e(TAG, "could not start the camera", it) }
            }, ContextCompat.getMainExecutor(ctx))
            previewView
        },
    )
}

@OptIn(ExperimentalGetImage::class)
private fun qrAnalyzer(
    scanner: com.google.mlkit.vision.barcode.BarcodeScanner,
    handled: java.util.concurrent.atomic.AtomicBoolean,
    onScanned: (String) -> Unit,
) = ImageAnalysis.Analyzer { imageProxy: ImageProxy ->
    val mediaImage = imageProxy.image
    if (mediaImage == null || handled.get()) {
        imageProxy.close()
        return@Analyzer
    }

    val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
    scanner.process(image)
        .addOnSuccessListener { barcodes ->
            val value = barcodes.firstOrNull { it.format == Barcode.FORMAT_QR_CODE }?.rawValue
            // compareAndSet, not a plain check: several frames can be in
            // flight and each would otherwise deliver the same payload.
            if (value != null && handled.compareAndSet(false, true)) onScanned(value)
        }
        .addOnFailureListener { Log.w(TAG, "barcode scan failed", it) }
        // Not closing the proxy stalls the whole analysis pipeline.
        .addOnCompleteListener { imageProxy.close() }
}
