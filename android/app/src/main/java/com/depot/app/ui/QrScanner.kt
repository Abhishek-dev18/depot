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
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.depot.app.ui.components.AppBar
import com.depot.app.ui.components.FailState
import com.depot.app.ui.components.IconClose
import com.depot.app.ui.components.IcoButton
import com.depot.app.ui.components.SheetButton
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.DepotType
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

private const val TAG = "QrScanner"

/**
 * SCAN · READ QR, as the interface artifact draws it: a full-bleed
 * viewfinder, corner brackets rather than a box, and a sweeping amber
 * line. Nothing else competes with it.
 *
 * This is also the security anchor of the whole protocol (§3.1). The
 * Client's ephemeral public key reaches the Depot through the camera
 * precisely because Signal cannot touch it there, which is why scanning
 * gets the whole screen and pasting is tucked underneath as a fallback.
 */
@Composable
fun QrScannerScreen(
    onScanned: (String) -> Unit,
    onCancel: () -> Unit,
    onPaste: () -> Unit,
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

    Column(modifier.fillMaxSize().background(DepotColors.ScanBg).statusBarsPadding()) {
        AppBar(
            title = "Link device",
            sub = "STEP 1 OF 2",
            action = {
                IcoButton(onClick = onCancel) { IconClose(DepotColors.Ink2, 16.dp) }
            },
        )

        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (granted) {
                CameraPreview(onScanned = onScanned)
                ScanTexture(Modifier.fillMaxSize())
                Reticle(Modifier.align(Alignment.Center))
                Text(
                    "POINT AT THE CODE ON YOUR SCREEN",
                    style = DepotType.Pulse,
                    color = DepotColors.Ink2,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .padding(horizontal = 24.dp, vertical = 34.dp),
                )
            } else {
                FailState(
                    title = "Camera access is off",
                    body = "Depot reads the Client's code through the camera because that is the " +
                        "one channel the Signal server cannot reach. Without it, the payload has " +
                        "to be pasted across by hand.",
                    accent = DepotColors.Amber,
                    modifier = Modifier.align(Alignment.Center).padding(horizontal = 24.dp),
                )
            }
        }

        Column(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 20.dp, vertical = 16.dp),
        ) {
            SheetButton(
                text = if (granted) "Paste the payload instead" else "Paste the payload",
                primary = !granted,
                onClick = onPaste,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** `.reticle` — four corner brackets and a sweeping line, not a frame. */
@Composable
private fun Reticle(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "scan")
    val sweep by transition.animateFloat(
        initialValue = 0.06f,
        targetValue = 0.94f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 2200, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "sweep",
    )

    Canvas(modifier.size(248.dp)) {
        val s = size.minDimension
        val w = 3.dp.toPx()
        val arm = s * 0.18f
        val a = w / 2f
        val b = s - w / 2f
        val amber = DepotColors.Amber

        // top-left
        drawLine(amber, Offset(a, a + arm), Offset(a, a), w, StrokeCap.Square)
        drawLine(amber, Offset(a, a), Offset(a + arm, a), w, StrokeCap.Square)
        // top-right
        drawLine(amber, Offset(b - arm, a), Offset(b, a), w, StrokeCap.Square)
        drawLine(amber, Offset(b, a), Offset(b, a + arm), w, StrokeCap.Square)
        // bottom-right
        drawLine(amber, Offset(b, b - arm), Offset(b, b), w, StrokeCap.Square)
        drawLine(amber, Offset(b, b), Offset(b - arm, b), w, StrokeCap.Square)
        // bottom-left
        drawLine(amber, Offset(a + arm, b), Offset(a, b), w, StrokeCap.Square)
        drawLine(amber, Offset(a, b), Offset(a, b - arm), w, StrokeCap.Square)

        val y = s * sweep
        drawLine(
            brush = Brush.horizontalGradient(
                listOf(Color.Transparent, amber, Color.Transparent),
            ),
            start = Offset(s * 0.04f, y),
            end = Offset(s * 0.96f, y),
            strokeWidth = 2.dp.toPx(),
            cap = StrokeCap.Butt,
        )
    }
}

/** `.scanbg` — faint scan lines over the preview, so it reads as an instrument. */
@Composable
private fun ScanTexture(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val gap = 4.dp.toPx()
        var y = 0f
        while (y < size.height) {
            drawLine(
                Color.White.copy(alpha = 0.014f),
                Offset(0f, y),
                Offset(size.width, y),
                1f,
                StrokeCap.Butt,
            )
            y += gap
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
