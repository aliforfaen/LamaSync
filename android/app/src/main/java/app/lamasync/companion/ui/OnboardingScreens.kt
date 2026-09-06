package app.lamasync.companion.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.atomic.AtomicBoolean

@Composable
fun WelcomeScreen(
    state: UiState,
    onScan: () -> Unit,
    onReset: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("LamaSync Companion", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(12.dp))
        Text(
            if (state.registration != null) {
                "Paired with ${state.registration.origin}, but the stored credentials could not be " +
                    "unlocked on this device (key material lost). Reset the pairing below, then " +
                    "enroll again from the desktop."
            } else {
                "Manage your LamaSync fleet from your phone. Scan the Android enrollment " +
                    "QR code shown in the authenticated desktop web UI — one scan signs in " +
                    "both the native app and the embedded web UI."
            },
            style = MaterialTheme.typography.bodyLarge,
        )
        Spacer(Modifier.height(28.dp))
        Button(onClick = onScan, modifier = Modifier.fillMaxWidth().height(52.dp)) {
            Text(if (state.registration != null) "Enroll with a new server" else "Scan enrollment QR code", fontSize = MaterialTheme.typography.titleMedium.fontSize)
        }
        if (state.registration != null) {
            Spacer(Modifier.height(12.dp))
            OutlinedButton(onClick = onReset, modifier = Modifier.fillMaxWidth()) {
                Text("Clear this device and reset")
            }
        }
        Spacer(Modifier.height(16.dp))
        Text(
            "Enrollment grants this app full fleet administration through the embedded web UI " +
                "and a separate native identity that is strictly device-scoped.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
fun ScannerScreen(onQrScanned: (String) -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    val activity = context as? Activity
    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    var deniedOnce by remember { mutableStateOf(false) }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { result ->
        granted = result
        if (!result) deniedOnce = true
    }

    BackHandler { onBack() }

    Box(Modifier.fillMaxSize()) {
        if (granted) {
            QrCameraPreview(onQrScanned)
        } else {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("Camera permission", style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(8.dp))
                Text(
                    "The camera is used only to scan the enrollment QR code. No photos are " +
                        "taken or stored.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(20.dp))
                Button(onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) }) {
                    Text("Allow camera access")
                }
                if (deniedOnce &&
                    activity?.shouldShowRequestPermissionRationale(Manifest.permission.CAMERA) == false
                ) {
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = {
                        context.startActivity(
                            Intent(
                                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.fromParts("package", context.packageName, null),
                            ),
                        )
                    }) {
                        Text("Open app settings")
                    }
                }
            }
        }
        Surface(
            modifier = Modifier.align(Alignment.TopStart),
            color = Color.Transparent,
        ) {
            TextButton(onClick = onBack) {
                Text("‹ Back", fontWeight = FontWeight.SemiBold)
            }
        }
        // Scan-frame overlay hint.
        Surface(
            modifier = Modifier
                .align(Alignment.Center)
                .size(220.dp),
            shape = RoundedCornerShape(16.dp),
            border = BorderStroke(2.dp, MaterialTheme.colorScheme.primary),
            color = Color.Transparent,
        ) {}
        Text(
            "Point the camera at the desktop QR code",
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 48.dp),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// CameraX marks ImageProxy.image experimental (lint's UnsafeOptInUsageError does
// not honor kotlin @OptIn for androidx markers); the compiler opt-in below is
// required to use the API at all, so this localized suppression is intentional.
@SuppressLint("UnsafeOptInUsageError")
@OptIn(ExperimentalGetImage::class)
@Composable
private fun QrCameraPreview(onQrScanned: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val mainExecutor = remember { ContextCompat.getMainExecutor(context) }
    val consumed = remember { AtomicBoolean(false) }

    AndroidView(
        factory = { ctx ->
            val previewView = PreviewView(ctx)
            val future = ProcessCameraProvider.getInstance(ctx)
            future.addListener(
                {
                    try {
                        val cameraProvider = future.get()
                        val preview = Preview.Builder().build().also {
                            it.surfaceProvider = previewView.surfaceProvider
                        }
                        val analysis = ImageAnalysis.Builder()
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .build()
                        val scanner = BarcodeScanning.getClient(
                            BarcodeScannerOptions.Builder()
                                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                                .build(),
                        )
                        analysis.setAnalyzer(mainExecutor) { imageProxy ->
                            val mediaImage = imageProxy.image
                            if (mediaImage == null) {
                                imageProxy.close()
                                return@setAnalyzer
                            }
                            val input = InputImage.fromMediaImage(
                                mediaImage,
                                imageProxy.imageInfo.rotationDegrees,
                            )
                            scanner.process(input)
                                .addOnSuccessListener { barcodes ->
                                    val raw = barcodes.firstOrNull { barcode ->
                                        !barcode.rawValue.isNullOrBlank()
                                    }?.rawValue
                                    if (raw != null && consumed.compareAndSet(false, true)) {
                                        onQrScanned(raw)
                                    }
                                }
                                .addOnCompleteListener { imageProxy.close() }
                        }
                        cameraProvider.unbindAll()
                        cameraProvider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            analysis,
                        )
                    } catch (e: Exception) {
                        // Camera unavailable: the permission prompt is the user-visible error path.
                    }
                },
                ContextCompat.getMainExecutor(ctx),
            )
            previewView
        },
        modifier = Modifier.fillMaxSize(),
    )
}

@Composable
fun ConfirmScreen(
    state: UiState,
    onConfirm: (String) -> Unit,
    onBack: () -> Unit,
) {
    val candidate = state.candidate
    BackHandler { onBack() }
    var name by remember(candidate) { mutableStateOf(state.suggestedDeviceName) }
    val origin = candidate?.serverOrigin ?: return

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Confirm server", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(16.dp))
        Text(
            "This QR code will enroll this phone with:",
            style = MaterialTheme.typography.bodyLarge,
        )
        Spacer(Modifier.height(8.dp))
        Surface(
            shape = RoundedCornerShape(12.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                origin,
                modifier = Modifier.padding(16.dp),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "This grants full fleet administration through the embedded web UI and a " +
                "separate native identity scoped to this device. The enrollment code " +
                "expires 10 minutes after it is generated.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(20.dp))
        OutlinedTextField(
            value = name,
            onValueChange = { name = it.take(64) },
            label = { Text("Device name") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(20.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = onBack) {
                Text("Change server")
            }
            Button(onClick = { onConfirm(name) }, modifier = Modifier.weight(1f)) {
                Text("Enroll this server")
            }
        }
    }
}

@Composable
fun ProgressScreen(label: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator()
            Spacer(Modifier.height(16.dp))
            Text(label, style = MaterialTheme.typography.titleMedium)
        }
    }
}
