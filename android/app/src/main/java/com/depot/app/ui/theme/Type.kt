package com.depot.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.depot.app.R

/**
 * The artifact's type pairing, now with the actual typefaces rather than
 * the platform's stand-ins.
 *
 * The split is a stated design decision, not decoration: anything the
 * system asserts — identity keys, byte counts, timestamps, throughput, the
 * SAS — is set in IBM Plex Mono, and anything a person wrote or chose is
 * set in Space Grotesk. A reader can tell at a glance which is which.
 *
 * Both faces ship under the SIL Open Font License; see
 * android/FONTS.md.
 */
val Sans = FontFamily(
    Font(R.font.space_grotesk_regular, FontWeight.Normal),
    Font(R.font.space_grotesk_medium, FontWeight.Medium),
    Font(R.font.space_grotesk_semibold, FontWeight.SemiBold),
    Font(R.font.space_grotesk_bold, FontWeight.Bold),
)

val Mono = FontFamily(
    Font(R.font.ibm_plex_mono_regular, FontWeight.Normal),
    Font(R.font.ibm_plex_mono_medium, FontWeight.Medium),
    Font(R.font.ibm_plex_mono_semibold, FontWeight.SemiBold),
)

/**
 * The artifact draws its phone screens at 272px wide, which stands in for
 * a real ~393dp handset. Sizes here are that mock scaled up to the device,
 * then rounded to values Android's own type scale would recognise.
 */
object DepotType {

    /** `.lbl`, `.sub`, `.cap` — mono, small caps, widely tracked. */
    val Label = TextStyle(
        fontFamily = Mono,
        fontWeight = FontWeight.Medium,
        fontSize = 10.sp,
        lineHeight = 15.sp,
        letterSpacing = 0.16.em,
    )

    /** `.pulse` — the same, a shade larger where it carries live state. */
    val Pulse = TextStyle(
        fontFamily = Mono,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.12.em,
    )

    /** `.hrow b`, `.mt`, `.fs` — machine facts in running text. */
    val Fact = TextStyle(
        fontFamily = Mono,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        lineHeight = 19.sp,
        letterSpacing = 0.02.em,
    )

    val FactSmall = TextStyle(
        fontFamily = Mono,
        fontWeight = FontWeight.Normal,
        fontSize = 11.sp,
        lineHeight = 17.sp,
        letterSpacing = 0.06.em,
    )

    /** `.bignum` — the one number the home screen is actually about. */
    val BigNum = TextStyle(
        fontFamily = Sans,
        fontWeight = FontWeight.SemiBold,
        fontSize = 38.sp,
        lineHeight = 42.sp,
        letterSpacing = (-0.02).em,
    )

    /** `.appbar .t`, `.sheet h3`, `.failttl` */
    val Title = TextStyle(
        fontFamily = Sans,
        fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
        letterSpacing = (-0.01).em,
    )

    /** `.dev .nm`, `.fn`, `.opt` — a row's human-authored name. */
    val RowName = TextStyle(
        fontFamily = Sans,
        fontWeight = FontWeight.Medium,
        fontSize = 16.sp,
        lineHeight = 22.sp,
    )

    /** `.btn`, `.cta` */
    val Button = TextStyle(
        fontFamily = Sans,
        fontWeight = FontWeight.SemiBold,
        fontSize = 17.sp,
        lineHeight = 22.sp,
        letterSpacing = 0.01.em,
    )

    /** `.warnline`, `.failsub`, `.pairsub` — prose addressed to a person. */
    val Body = TextStyle(
        fontFamily = Sans,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 21.sp,
    )

    /** `.sasdigits b` — the largest thing on the screen it appears on. */
    val SasDigit = TextStyle(
        fontFamily = Mono,
        fontWeight = FontWeight.SemiBold,
        fontSize = 32.sp,
        lineHeight = 38.sp,
        letterSpacing = 0.em,
    )
}


val DepotTypography = Typography(
    headlineMedium = DepotType.BigNum,
    titleLarge = DepotType.Title,
    titleMedium = DepotType.RowName,
    bodyLarge = DepotType.Body,
    bodyMedium = DepotType.Body.copy(fontSize = 13.sp, lineHeight = 19.sp),
    labelLarge = DepotType.Button,
    labelSmall = DepotType.Label,
)
