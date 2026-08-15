# True USB Write Progress+

> **This is a fork** of [true-usb-progress](https://github.com/ktauchathuranga/true-usb-progress)
> by [Ashen Chathuranga](https://github.com/ktauchathuranga).
>
> **What this fork adds:** detection of the transfer's target file size
> (via UDisks2 `Filesystem.MountPoints` + `Gio.FileMonitor`), so the
> indicator can show a real percentage and a graphical progress bar,
> instead of only "N MB written". Falls back to the original text-only
> display when the target size can't be determined (e.g. a file created
> in a subfolder, not currently watched).
>
> A pull request with this feature was submitted upstream:
> https://github.com/ktauchathuranga/true-usb-progress/pull/N
> (update with the actual PR number). This fork exists as a separately
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

This extension solves that by reading per-device I/O counters directly from `/sys/block/<dev>/stat` and applying heuristic filtering to distinguish real file writes from routine metadata chatter. This fork additionally detects the transfer's target size so it can show real percentage progress, not just a running byte count.

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

mkdir -p ~/.local/share/gnome-shell/extensions/true-usb-progress-plus@dr0p18.github.io

cp extension.js metadata.json \
   ~/.local/share/gnome-shell/extensions/true-usb-progress-plus@dr0p18.github.io/

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
|   UDisks2 (D-Bus)   |       |  /sys/block/<dev>/stat     |
|                     |       |  (kernel block-layer I/O)  |
+--------+------------+       +-------------+--------------+
         |                                  |
         | GetManagedObjects                | readFileSync()
         | InterfacesAdded/Removed          | every 2 seconds
         | (+ Filesystem.MountPoints)        |
         |                                  |
+--------v----------------------------------v--------------+
|                                                          |
|              TrueUsbProgressExtension                    |
|                                                          |
|  _removableDevices   Map<devName, { label, mountPoint,   |
|                                     targetFile,           |
|                                     targetSize }>         |
|  _devStats           Map<devName, DeviceState>           |
|  _fileMonitors        Map<devName, Gio.FileMonitor>       |
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

1. The parent `Drive` interface has `Removable == true` and `ConnectionBus == "usb"`
2. The block device exposes an `org.freedesktop.UDisks2.Filesystem` interface (i.e., it is mounted)

It subscribes to `InterfacesAdded` and `InterfacesRemoved` signals to dynamically track USB hotplug and mount/unmount events without polling D-Bus.

**Fork addition — Target size detection**

For each tracked device, the extension also reads `Filesystem.MountPoints` to learn where it's mounted, and opens a `Gio.FileMonitor` on that directory. When a file above `MIN_TARGET_FILE_SIZE_BYTES` (default 20MB) is created there, its size is read via `Gio.File.query_info()` and stored as the transfer's target size. Many filesystems/copy tools preallocate the final file size immediately, so this is usually available right at the start of a large transfer.

**I/O Monitoring (`/sys/block/<dev>/stat`)**

Every 2 seconds, the extension reads the kernel's block-layer statistics for each tracked device. The relevant fields from `/sys/block/<dev>/stat` are:

| Field Index | Name              | Description                            |
|-------------|-------------------|----------------------------------------|
| 4           | writes completed  | Total completed write requests         |
| 6           | sectors written   | Total 512-byte sectors written         |
| 8           | in-flight I/Os    | Currently queued I/O operations        |

Partition names (e.g., `sdb1`) are automatically resolved to parent disk names (e.g., `sdb`) since `/sys/block/` only contains whole-disk entries. This resolution handles SCSI/USB (`sdXN`), NVMe (`nvmeXnYpZ`), and MMC (`mmcblkNpM`) naming schemes.

**Two-Phase Write Detection**

A per-device state machine prevents false positives from small metadata writes (journal commits, inode updates, directory entries) while maintaining indicator visibility during legitimate file copy operations:

**Phase 1 -- TRIGGER (strict thresholds)**

Both conditions must be met simultaneously to start tracking a write burst:

- Delta bytes >= 64 KB per tick (~32 KB/s at 2-second polling)
- Average I/O request size >= 16 KB

Small, frequent writes typical of filesystem metadata will not pass these thresholds.

**Phase 2 -- SUSTAIN (permissive)**

Once triggered, any write activity (even small sector changes or in-flight I/O) keeps the indicator alive. This prevents the indicator from flickering off during gaps between kernel writeback rounds.

**DONE (idle detection)**

The burst ends only after 5 consecutive idle ticks (10 seconds) with zero sector changes and zero in-flight I/O. This generous grace period accounts for the bursty nature of Linux's writeback mechanism. Fork addition: at this point the device's `targetFile`/`targetSize` are also reset, so the next detected file starts a fresh transfer.

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

**Indicator (Top Bar)**

A `PanelMenu.Button` with a USB drive icon and a dynamic label. Hidden when no writes are active. When one or more devices are writing, the label shows:

```
DEVICE_LABEL: 42% · 123.4/294.0 MB (5.2 MB/s) · DEVICE_2: 45.0 MB
```

- Percentage and a small graphical bar when the target size is known (fork addition)
- Total bytes written in the current burst, and target size when known
- Live write speed (updated each tick when new data arrives)
- Multiple active devices are separated by ` · `
- Speed display is suppressed when a device is in a writeback gap (shows only total)

**Notifications**

When a device transitions from WRITING to DONE, a desktop notification fires:

> **USB Sync Complete**
> Write cache flushed -- safe to eject DEVICE_LABEL.

A 10-second cooldown prevents notification spam when multiple devices finish in quick succession.

## Configuration

The extension currently has no user-configurable settings (no GSettings schema). All thresholds are compile-time constants in `extension.js`:

| Constant                    | Default   | Description                                          |
|-----------------------------|-----------|-------------------------------------------------------|
| `POLL_INTERVAL_SECONDS`     | `2`       | Seconds between I/O stat reads                       |
| `NOTIFY_COOLDOWN_MS`        | `10000`   | Minimum ms between "safe to eject" notifications     |
| `MIN_WRITE_RATE_BYTES`      | `65536`   | Minimum bytes/tick to trigger Phase 1 (64 KB)        |
| `MIN_AVG_IO_SIZE_BYTES`     | `16384`   | Minimum average I/O request size for Phase 1 (16 KB) |
| `IDLE_TICKS_BEFORE_DONE`    | `5`       | Consecutive idle ticks before declaring DONE          |
| `MIN_TARGET_FILE_SIZE_BYTES`| `20971520`| Fork addition: min file size to be considered "the transfer" (20 MB) |
| `BAR_WIDTH_PX`               | `80`      | Fork addition: fixed width of the graphical progress bar |

## File Structure

```
true-usb-progress-plus@dr0p18.github.io/
  extension.js    -- Extension logic (single-file)
  metadata.json   -- GNOME Shell extension manifest
```

## Dependencies

- **Runtime**: GNOME Shell 45+, UDisks2 (present on all standard GNOME installations)
- **System interfaces**: `/sys/block/*/stat` (Linux sysfs, always available)
- **D-Bus**: System bus access to `org.freedesktop.UDisks2`
- **No external libraries or build tools required**

## How It Works (Summary)

1. On `enable()`, connects to UDisks2 over D-Bus and enumerates mounted USB drives
2. Subscribes to D-Bus signals for dynamic hotplug/unmount tracking
3. Fork addition: reads each device's mount point and watches it with `Gio.FileMonitor` to detect the transfer's target file/size
4. Starts a 2-second GLib polling loop
5. Each tick: reads `/sys/block/<dev>/stat` for every tracked device, computes sector deltas
6. Per-device state machine filters metadata writes and tracks real file copy bursts
7. Top-bar indicator shows live progress (with percentage/bar when target size is known); hides when idle
8. Desktop notification fires when all pending writes are flushed
9. On `disable()`, all timers, signal subscriptions, file monitors, and UI elements are cleaned up

## Debugging

Monitor extension logs in real time:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Look for log lines prefixed with `[TrueUsbProgress]`:

```
[TrueUsbProgress] Tracking USB device: /dev/sdb1 ("MY_USB") mount=/run/media/user/MY_USB
```

## License

MIT — see [LICENSE](./LICENSE). Original copyright retained; fork
modifications copyright dr0p18.
