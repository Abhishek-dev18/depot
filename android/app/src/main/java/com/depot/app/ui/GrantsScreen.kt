package com.depot.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.depot.app.ui.components.AppBar
import com.depot.app.ui.components.Cta
import com.depot.app.ui.components.GrantSwitch
import com.depot.app.ui.components.IcoButton
import com.depot.app.ui.components.IconBack
import com.depot.app.ui.components.IconGrant
import com.depot.app.ui.components.ListRow
import com.depot.app.ui.components.RowTile
import com.depot.app.ui.components.SectionLabel
import com.depot.app.ui.components.formatBytes
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.DepotType

/**
 * ACCESS · FOLDER GRANTS.
 *
 * The interface spec's position is that Android's per-folder consent is
 * the feature, not an apology for it: rather than hiding the Storage
 * Access Framework behind a vague permission prompt, the app shows a plain
 * list of exactly what a Client can reach, and says outright that
 * everything else is invisible.
 */
@Composable
fun GrantsScreen(
    grants: List<GrantView>,
    offeredFileName: String?,
    offeredFileSize: Int,
    onAddFolder: () -> Unit,
    onToggle: (GrantView, Boolean) -> Unit,
    onToggleWritable: (GrantView, Boolean) -> Unit,
    onForget: (GrantView) -> Unit,
    onPickFile: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxSize().background(DepotColors.Bg).statusBarsPadding()) {
        AppBar(
            title = "Shared folders",
            sub = "WHAT CLIENTS CAN SEE",
            action = {
                IcoButton(onClick = onBack) { IconBack(DepotColors.Ink2, 16.dp) }
            },
        )

        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            if (grants.isEmpty() && offeredFileName == null) {
                SectionLabel("NOTHING SHARED")
                Text(
                    "A Client that connects right now would see an empty Depot. " +
                        "Add a folder and it becomes browsable — nothing else does.",
                    style = DepotType.Body.copy(fontSize = 13.sp),
                    color = DepotColors.Ink3,
                )
            }

            if (grants.isNotEmpty()) {
                SectionLabel("FOLDERS")
                for (view in grants) {
                    ListRow(
                        name = view.grant.label,
                        meta = view.summary(),
                        nameColor = if (view.grant.enabled) DepotColors.Ink else DepotColors.Ink3,
                        onClick = { onToggle(view, !view.grant.enabled) },
                        leading = {
                            RowTile {
                                IconGrant(
                                    if (view.grant.enabled) DepotColors.Amber else DepotColors.Ink3,
                                    18.dp,
                                )
                            }
                        },
                        trailing = { GrantSwitch(on = view.grant.enabled) },
                    )
                    // protocol.md §5.10. Asked separately from sharing,
                    // and only once sharing is on, because granting a
                    // folder to read from is not consent to have things
                    // put into it — they are different questions.
                    if (view.grant.enabled) {
                        ListRow(
                            name = "Accept files into this folder",
                            meta = if (view.grant.writable) {
                                "A paired device may add files here. Nothing is ever overwritten."
                            } else {
                                "Read only — a paired device cannot put anything here."
                            },
                            nameColor = if (view.grant.writable) DepotColors.Ink else DepotColors.Ink3,
                            onClick = { onToggleWritable(view, !view.grant.writable) },
                            leading = {
                                RowTile {
                                    IconGrant(
                                        if (view.grant.writable) DepotColors.Green else DepotColors.Ink3,
                                        16.dp,
                                    )
                                }
                            },
                            trailing = { GrantSwitch(on = view.grant.writable) },
                        )
                    }

                    // Forgetting is offered only once sharing is already
                    // off, so releasing the permission is a second,
                    // deliberate step rather than a mis-tap.
                    if (!view.grant.enabled) {
                        Text(
                            "FORGET THIS FOLDER",
                            style = DepotType.Label,
                            color = DepotColors.Red,
                            modifier = Modifier
                                .clickable { onForget(view) }
                                .padding(start = 14.dp, top = 2.dp, bottom = 14.dp),
                        )
                    }
                }
            }

            SectionLabel("SINGLE FILE")
            ListRow(
                name = offeredFileName ?: "Offer one file instead",
                meta = if (offeredFileName == null) {
                    "WITHOUT GRANTING A WHOLE FOLDER"
                } else {
                    "${formatBytes(offeredFileSize.toLong())} · SHARED ON ITS OWN"
                },
                nameColor = if (offeredFileName == null) DepotColors.Ink2 else DepotColors.Ink,
                onClick = onPickFile,
                leading = {
                    RowTile {
                        IconGrant(
                            if (offeredFileName == null) DepotColors.Ink3 else DepotColors.Amber,
                            18.dp,
                        )
                    }
                },
                trailing = { GrantSwitch(on = offeredFileName != null) },
            )

            SectionLabel("NOT SHARED")
            Text(
                "Everything else on this phone stays invisible. A Client is never given " +
                    "a name for anything outside this list, so there is nothing for it to ask for.",
                style = DepotType.Body.copy(fontSize = 13.sp),
                color = DepotColors.Ink3,
            )

            Spacer(Modifier.height(24.dp))
        }

        Box(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 20.dp, vertical = 16.dp),
        ) {
            Cta(text = "Share a folder", onClick = onAddFolder)
        }
    }
}
