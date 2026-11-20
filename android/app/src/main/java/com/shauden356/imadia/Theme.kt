package com.shauden356.imadia

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// The logo's colours, as in the desktop app: navy ink, lavender surfaces, sky blue accents.
private val Light = lightColorScheme(
    primary = Color(0xFF1D2B52),
    onPrimary = Color.White,
    secondaryContainer = Color(0xFFDAE0F2),
    onSecondaryContainer = Color(0xFF1C2340),
    tertiary = Color(0xFF2F7D4F),
    background = Color(0xFFF4F5FA),
    surface = Color(0xFFF4F5FA),
    surfaceVariant = Color(0xFFECEEF6),
    onSurface = Color(0xFF1C2340),
    onSurfaceVariant = Color(0xFF646C86),
    outlineVariant = Color(0xFFDDE1EE),
    error = Color(0xFFB3261E),
)

private val Dark = darkColorScheme(
    primary = Color(0xFFA0D5FF),
    onPrimary = Color(0xFF0F1D3A),
    secondaryContainer = Color(0xFF232C52),
    onSecondaryContainer = Color(0xFFE8EBF7),
    tertiary = Color(0xFF7FD3A0),
    background = Color(0xFF12162A),
    surface = Color(0xFF12162A),
    surfaceVariant = Color(0xFF1A1F38),
    onSurface = Color(0xFFE8EBF7),
    onSurfaceVariant = Color(0xFF9AA2BF),
    outlineVariant = Color(0xFF2B3256),
    error = Color(0xFFFF8A80),
)

@Composable
fun ImadiaTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}
