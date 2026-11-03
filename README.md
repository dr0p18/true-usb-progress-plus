# True USB Write Progress+

> **This is a fork** of [true-usb-progress](https://github.com/ktauchathuranga/true-usb-progress)
> by [Ashen Chathuranga](https://github.com/ktauchathuranga).
>
> **What this fork adds:** detection of the transfer's target file size
> (via UDisks2 `Filesystem.MountPoints` + `Gio.FileMonitor`), so the
> indicator can show a real percentage and a graphical progress bar,
> instead of only "N MB written". Falls back to the original text-only
> display when the target size can't be determined (e.g. files written into
> a folder that already existed on the drive, which is not watched).
>
> It also adds: a compact panel item (icon, bar, percentage) with a details
> menu and a **Flush now** action; a stricter "safe to eject" decision that
> waits until the data is really on the device; support for LUKS-encrypted
> drives; and an indicator that appears as soon as a copy starts, while the
> data is still only in the page cache.
>
> Other fork changes: mount/unmount is detected via `PropertiesChanged`
> (the original only reacted to interfaces being added/removed), per-partition
> stats are read from `/sys/class/block/<part>/stat`, bytes are only counted
> while a burst is active, file queries are asynchronous, and the
> "safe to eject" cooldown is per device.
>
> A pull request with this feature was submitted upstream:
> https://github.com/ktauchathuranga/true-usb-progress/pull/4
> This fork exists as a separately
> installable extension while that PR is pending review; if/when it's
> merged upstream, this fork will likely be archived in favor of the
> original project.
>
> Everything below this point is the original project's documentation,
> updated only where it describes the new behaviour above.

---

A GNOME Shell extension that monitors real-time kernel dirty-cache writes destined for removable USB block devices. It displays a top-bar indicator with live write speed and total bytes transferred, and notifies you when the flush is complete so you know exactly when a drive is safe to eject.

## The Problem

When you copy files to a USB drive on Linux, the file manager often reports the operation as "complete" while the data is still sitting in the kernel's write-back cache. Ejecting the drive at this point can result in data corruption. There is no built-in visual feedback for the actual flush progress.

This extension solves that by reading per-device I/O counters directly from `/sys/class/block/<dev>/stat` and applying heuristic filtering to distinguish real file writes from routine metadata chatter. This fork additionally detects the transfer's target size so it can show real percentage progress, not just a running byte count.

## Compatibility

| GNOME Shell | Status    |
|-------------|-----------|
| 45          | Supported |
| 46          | Supported |
| 47          | Supported |
| 48          | Supported |
| 49          | Supported |
| 50          | Supported |

Uses ESM imports (`gi://`). No legacy `imports.gi` compatibility.

## Installation

### From Source

```bash
git clone https://github.com/dr0p18/true-usb-progress-plus.git
cd true-usb-progress-plus

# Builds the zip (compiling the translations in po/) and installs it
gnome-extensions pack --force --podir=po --extra-source=LICENSE .
gnome-extensions install --force true-usb-progress-plus@dr0p18.github.io.shell-extension.zip

# Restart GNOME Shell (X11: Alt+F2, type 'r', Enter)
# On Wayland: log out and log back in

gnome-extensions enable true-usb-progress-plus@dr0p18.github.io
```

### Verify Installation

```bash
gnome-extensions list | grep true-usb-progress-plus
gnome-extensions info true-usb-progress-plus@dr0p18.github.io
```

## Architecture

```
+---------------------+       +----------------------------+
|   UDisks2 (D-Bus)   |       |  /sys/class/block/<dev>/stat |
|                     |       |  (kernel block-layer I/O)  |
+--------+------------+       +-------------+--------------+
         |                                  |
         | GetManagedObjects                | async read   
         | InterfacesAdded/Removed          | every 2 seconds
         | (+ Filesystem.MountPoints)        |
         |                                  |
+--------v----------------------------------v--------------+
|                                                          |
|              TrueUsbProgressExtension                    |
|                                                          |
|  _removableDevices   Map<devName, { label, mountPoint }> |
|  _devStats           Map<devName, DeviceState>           |
|  _watches            Map<devName, { monitors, openFiles, |
|                                     closedBytes }>       |
|                                                          |
|  Per-device two-phase state machine:                     |
|    Phase 1 (TRIGGER)  -->  Phase 2 (SUSTAIN)  -->  DONE  |
|                                                          |
+--------+-------------------------+-----------------------+
         |                         |
         v                         v
  PanelMenu.Button           Main.notify()
  (top-bar indicator +       ("safe to eject")
   progress bar when
   target size known)
```

### Component Breakdown

**Device Discovery (UDisks2 D-Bus)**

The extension connects to the system bus and calls `GetManagedObjects` on `org.freedesktop.UDisks2` to enumerate all block devices. It filters for devices where:

1. The parent `Drive` interface has `Removable == true` and `ConnectionBus == "usb"`. Fork addition: an unlocked LUKS volume (`dm-N`) has no `Drive` of its own, so its `CryptoBackingDevice` is followed to the physical drive. LVM on top of LUKS is not resolved yet.
2. The block device exposes an `org.freedesktop.UDisks2.Filesystem` interface (i.e., it is mounted)

It subscribes to `InterfacesAdded` and `InterfacesRemoved` signals to dynamically track USB hotplug and mount/unmount events without polling D-Bus.

**Fork addition — Target size detection**

For each tracked device the extension reads `Filesystem.MountPoints` and opens a `Gio.FileMonitor` on the mount root. Every file created there (or in a directory created during the transfer, up to 32 directories per device) is tracked:

- while a file is still open, its current size is re-read asynchronously every tick;
- when it is closed (`CHANGES_DONE_HINT`) its final size is added to a running total;
- GIO's `.goutputstream-*` temp files are followed through the rename to their final name.

The sum is the amount of data the copy has handed to the kernel so far. Bytes written to the device during the burst divided by that sum is the percentage shown. While a multi-file copy is still filling the page cache the total grows, so the shown percentage is held monotonic, and it is capped at 99% until the burst is DONE.

Files moved in from elsewhere on the same drive, writes into pre-existing directories (other than the mount root) and hidden directories are not tracked.

**I/O Monitoring (`/sys/class/block/<dev>/stat`)**

Every 2 seconds, the extension reads the kernel's block-layer statistics for each tracked device. The relevant fields from `/sys/class/block/<dev>/stat` are:

| Field Index | Name              | Description                            |
|-------------|-------------------|----------------------------------------|
| 4           | writes completed  | Total completed write requests         |
| 6           | sectors written   | Total 512-byte sectors written         |
| 8           | in-flight I/Os    | Currently queued I/O operations        |

Fork change: the original resolved partition names (e.g., `sdb1`) to the parent disk (`sdb`) and read `/sys/block/sdb/stat`. Partitions have their own stat file with the same format under `/sys/class/block/`, so this fork reads the partition directly; two mounted partitions of the same stick are no longer double-counted.

**Two-Phase Write Detection**

A per-device state machine prevents false positives from small metadata writes (journal commits, inode updates, directory entries) while maintaining indicator visibility during legitimate file copy operations:

**Phase 1 -- TRIGGER (strict thresholds)**

Both conditions must be met simultaneously to start tracking a write burst:

- Delta bytes >= 64 KB per tick (~32 KB/s at 2-second polling)
- Average I/O request size >= 16 KB

Small, frequent writes typical of filesystem metadata will not pass these thresholds.

Fork addition: a burst also starts as soon as files being copied to the drive add up to 4 MB, before the kernel has written anything, so the indicator is visible while the data is still only cached in memory. Sparse or preallocated files are counted by their allocated size.

**Phase 2 -- SUSTAIN (permissive)**

Once triggered, any write activity (even small sector changes or in-flight I/O) keeps the indicator alive. This prevents the indicator from flickering off during gaps between kernel writeback rounds.

**DONE (idle detection)**

The burst ends only after 5 consecutive idle ticks (10 seconds) with zero sector changes and zero in-flight I/O. This generous grace period accounts for the bursty nature of Linux's writeback mechanism. Fork addition: at this point the device's tracked target files are also reset, so the next transfer starts fresh.

Fork change: an idle device is not enough. Linux can keep a copy in the page cache, untouched, for up to `vm.dirty_expire_centisecs` (30 s by default), with the device completely idle meanwhile. DONE therefore also requires that the bytes flushed in this burst reached the target size (when known) **and** that the whole system has at most 64 MB of `Dirty` + `Writeback` data left (`/proc/meminfo`). Failing that, DONE is declared once the device has been idle for `dirty_expire + dirty_writeback` + 6 s, read from `/proc/sys/vm`; with `dirty_writeback_centisecs = 0` (periodic writeback disabled) there is no such timeout. DONE is also never declared while a tracked file is still growing.

```
              +------------------+
              |     IDLE         |
              | (indicator off)  |
              +--------+---------+
                       |
                       | large write detected
                       | (>= 64KB/tick AND >= 16KB avg I/O)
                       v
              +------------------+
              |    WRITING       |
              | (indicator on)   |<---+
              +--------+---------+    |
                       |              | any activity or
                       |              | in-flight I/O
                       |              |
              +--------v---------+    |
              |   IDLE TICK?     +----+
              | sector_delta==0  |
              | && in_flight==0  |
              +--------+---------+
                       |
                       | 5 consecutive idle ticks (10s)
                       v
              +------------------+
              |     DONE         |
              | notify + reset   |
              +------------------+
```

**Indicator (Top Bar)** — fork rework

A `PanelMenu.Button`, hidden when no writes are active (it fades in and out). The panel item stays compact:

```
[USB icon] [=====-----]  42%
```

- With a known target size: a progress bar and the combined percentage of all active devices; otherwise the bytes flushed so far (`1480 MB`).
- Tabular digits, padded with figure spaces, so the item doesn't shift as numbers change.
- The bar glides to each new value over 1.5 s at constant speed, so small steps move slowly and big writeback bursts move fast.
- When a burst is DONE: a check mark and a full green bar for 3.5 s, then it fades out.

Clicking it opens a menu with one row per active device (name, bar, `1.20 GB of 1.45 GB on the drive · 35.0 MB/s`, and the current state: *Writing to the drive…*, *Data cached in memory, waiting for the kernel to write it*, *Finishing up…*), plus **Flush now**, which runs `sync -f <mount point>` (`syncfs()`, no root needed) to write the cached data immediately instead of waiting for the kernel.

**Notifications**

When a device transitions from WRITING to DONE, a desktop notification fires:

> **USB Sync Complete**
> Write cache flushed -- safe to eject DEVICE_LABEL.

A 10-second per-device cooldown prevents notification spam.

## Configuration

The extension currently has no user-configurable settings (no GSettings schema). All thresholds are compile-time constants in `extension.js`:

| Constant                    | Default   | Description                                          |
|-----------------------------|-----------|-------------------------------------------------------|
| `POLL_INTERVAL_SECONDS`     | `2`       | Seconds between I/O stat reads                       |
| `NOTIFY_COOLDOWN_MS`        | `10000`   | Minimum ms between "safe to eject" notifications     |
| `MIN_WRITE_RATE_BYTES`      | `65536`   | Minimum bytes/tick to trigger Phase 1 (64 KB)        |
| `MIN_AVG_IO_SIZE_BYTES`     | `16384`   | Minimum average I/O request size for Phase 1 (16 KB) |
| `IDLE_TICKS_BEFORE_DONE`    | `5`       | Consecutive idle ticks before declaring DONE          |
| `MAX_WATCHED_DIRS_PER_DEVICE` | `32`  | Fork addition: max directories watched per device    |
| `TARGET_STALE_MS`           | `120000`  | Fork addition: forget tracked files if no burst starts within this time |
| `TARGET_TRIGGER_BYTES`      | `4 MB`    | Fork addition: copied data that starts a burst before any device write |
| `SYSTEM_PENDING_SAFE_BYTES` | `64 MB`   | Fork addition: max system-wide Dirty + Writeback for DONE |
| `OPEN_FILE_ACTIVE_MS`       | `15000`   | Fork addition: a tracked file that grew this recently blocks DONE |
| `PANEL_BAR_WIDTH_PX`        | `64`      | Fork addition: width of the panel progress bar       |
| `BAR_ANIM_MS`               | `1500`    | Fork addition: duration of each bar movement         |

## File Structure

```
true-usb-progress-plus@dr0p18.github.io/
  extension.js    -- Extension logic (single-file)
  stylesheet.css  -- Panel item, progress bars and menu rows
  metadata.json   -- GNOME Shell extension manifest
  po/             -- Translations (.pot template + one .po per language)
```

## Dependencies

- **Runtime**: GNOME Shell 45+, UDisks2 (present on all standard GNOME installations)
- **System interfaces**: `/sys/class/block/*/stat` (Linux sysfs, always available)
- **D-Bus**: System bus access to `org.freedesktop.UDisks2`
- **No external libraries or build tools required**

## How It Works (Summary)

1. On `enable()`, connects to UDisks2 over D-Bus and enumerates mounted USB drives
2. Subscribes to D-Bus signals for dynamic hotplug/unmount tracking
3. Fork addition: reads each device's mount point and watches it with `Gio.FileMonitor` to sum the sizes of the files being copied
4. Starts a 2-second GLib polling loop
5. Each tick: reads `/sys/class/block/<dev>/stat` for every tracked device, computes sector deltas
6. Per-device state machine filters metadata writes and tracks real file copy bursts
7. Top-bar indicator shows live progress (with percentage/bar when target size is known); hides when idle
8. Desktop notification fires when the device's data is known to be flushed
9. On `disable()`, all timers, signal subscriptions, file monitors, and UI elements are cleaned up

## Debugging

Monitor extension logs in real time:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Errors are logged with the prefix `[TrueUsbProgress]`.

## Translations

The interface is in English and translatable with gettext; an Italian
translation is included. To add a language:

```bash
# refresh the template after changing strings in extension.js
xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ \
    --add-comments=Translators -o po/true-usb-progress-plus.pot extension.js
msginit -i po/true-usb-progress-plus.pot -o po/<lang>.po -l <lang>
```

Then translate `po/<lang>.po` and open a pull request.

## Support

If this extension is useful to you, you can support:

- **the current maintainer** of True USB Write Progress+ on
  [Ko-fi](https://ko-fi.com/jacopoleonardi);
- **the original author** of True USB Write Progress via
  [GitHub Sponsors](https://github.com/sponsors/ktauchathuranga).

## License

MIT — see [LICENSE](./LICENSE). Original copyright retained; fork
modifications copyright dr0p18.
