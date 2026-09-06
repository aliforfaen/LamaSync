package app.lamasync.companion.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF1B5E4B),
    secondary = Color(0xFF37574C),
    tertiary = Color(0xFF8B5000),
    background = Color(0xFFFDF7F0),
    surface = Color(0xFFFFFFFF),
)

@Composable
fun LamaSyncTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = LightColors,
        content = content,
    )
}
