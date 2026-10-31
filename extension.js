/**
 * True USB Write Progress+ — GNOME Shell Extension
 * UUID : true-usb-progress-plus@dr0p18.github.io
 *
 * Fork of true-usb-progress@ktauchathuranga.github.io (MIT, Ashen Chathuranga).
 *
 * Monitors kernel dirty-cache writes destined for removable USB block
 * devices and shows a real-time top-bar indicator until the flush is done.
 *
 * Architecture:
 *  • UDisks2 D-Bus → discover which block devices are removable + mounted
 *  • /sys/class/block/<dev>/stat → per-device write sectors & I/O request counts
 *  • Delta tracking + threshold heuristics → ignore metadata writes,
 *    only trigger on real file copy/move operations
 *  • GLib.timeout_add_seconds → 2-second polling loop
 *  • PanelMenu.Button → hidden when idle, visible when writing
 *
 * GNOME 45 + (ESM – no legacy imports.gi)
 *
 * Fork addition: watches each mount point (and directories created during a
 * transfer) with Gio.FileMonitor, and sums the sizes of the files being
 * written there. Bytes actually flushed to the device divided by that total
 * gives a real percentage/progress bar. Falls back to the original
 * "N MB (rate)" text when no target files are known.
 */

import GLib     from 'gi://GLib';
import Gio      from 'gi://Gio';
import St       from 'gi://St';
import Clutter  from 'gi://Clutter';

import { Extension }   from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main       from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu  from 'resource:///org/gnome/shell/ui/panelMenu.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_SECONDS = 2;
const NOTIFY_COOLDOWN_MS    = 10_000; // min gap between "safe to eject" toasts (per device)

// ── Write-detection thresholds ───────────────────────────────────────────────
//
// Two-phase detection strategy:
//
//   Phase 1 — TRIGGER:  Strict thresholds to START a write burst.
//     Only large, sustained I/O can trigger the indicator.  This filters out
//     small metadata writes (journal commits, inode updates, dir entries).
//
//   Phase 2 — SUSTAIN:  Once triggered, ANY device write activity (even small)
//     keeps the indicator alive.  This prevents the indicator from flickering
//     off between kernel writeback bursts during an active copy.
//
//   DONE:  Only when the device is truly idle (zero sector change AND zero
//     in-flight I/O) for a sustained period do we declare the copy finished.

// Phase 1 thresholds (must pass BOTH to trigger)
const MIN_WRITE_RATE_BYTES  = 64 * 1024;  // 64 KB per tick (~32 KB/s @2s poll)
const MIN_AVG_IO_SIZE_BYTES = 16 * 1024;  // 16 KB avg request size

// How many consecutive "truly idle" ticks (no sector change, no in-flight)
// before declaring the write finished.  Linux writeback is bursty, so we need
// a generous window to avoid premature "done" between flush rounds.
// 5 ticks × 2 seconds = 10 second grace period.
const IDLE_TICKS_BEFORE_DONE = 5;

// Fork addition: target-file tracking limits.
const MAX_WATCHED_DIRS_PER_DEVICE = 32;     // root + directories created during a copy
const MAX_OPEN_FILES_PER_DEVICE   = 256;    // files still being written
const MAX_SIZE_QUERIES_PER_TICK   = 64;
// Forget target files if no write burst started this long after the last file
// event (e.g. small files whose writes never passed the trigger thresholds).
const TARGET_STALE_MS = 120_000;
// Never show 100% while the indicator is still up: filesystem metadata makes
// the device byte count overshoot the data size slightly before DONE.
const MAX_SHOWN_FRACTION = 0.99;

// Fork addition: fixed width (px) of the graphical progress bar in the panel.
const BAR_WIDTH_PX = 80;

// UDisks2 well-known names
const UDISKS2_BUS_NAME  = 'org.freedesktop.UDisks2';
const UDISKS2_OBJ_PATH  = '/org/freedesktop/UDisks2';
const DBUS_OBJMAN_IFACE = 'org.freedesktop.DBus.ObjectManager';
const DBUS_PROPS_IFACE  = 'org.freedesktop.DBus.Properties';
const UDISKS2_BLOCK     = 'org.freedesktop.UDisks2.Block';
const UDISKS2_DRIVE     = 'org.freedesktop.UDisks2.Drive';
const UDISKS2_FS        = 'org.freedesktop.UDisks2.Filesystem';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Promisify Gio async methods for async/await usage
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

/**
 * Read a text file asynchronously via Gio.
 * Returns null on any error so callers can handle gracefully.
 * @param {string} path
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<string|null>}
 */
async function readFileAsync(path, cancellable) {
    try {
        const file = Gio.File.new_for_path(path);
        const [contents] = await file.load_contents_async(cancellable);
        return new TextDecoder().decode(contents);
    } catch (_) {
        return null;
    }
}

/**
 * Parse /sys/class/block/<dev>/stat and return write-related counters.
 * Stat fields (0-indexed): https://www.kernel.org/doc/Documentation/block/stat.txt
 *   4 — writes completed
 *   5 — writes merged
 *   6 — sectors written  (each sector = 512 bytes)
 *   8 — I/Os currently in progress
 *
 * Fork change: partitions have their own stat file with the same format
 * under /sys/class/block/, so we read the partition directly instead of
 * mapping it to the parent disk. Two mounted partitions of the same stick
 * are no longer double-counted.
 *
 * @param {string} devName  e.g. "sdb1" or "sdb"
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<{ writesCompleted: number, sectorsWritten: number, inFlight: number }|null>}
 */
async function getBlockWriteStats(devName, cancellable) {
    const text = await readFileAsync(`/sys/class/block/${devName}/stat`, cancellable);
    if (!text) return null;
    const f = text.trim().split(/\s+/);
    return {
        writesCompleted : parseInt(f[4], 10) || 0,
        sectorsWritten  : parseInt(f[6], 10) || 0,
        inFlight        : parseInt(f[8], 10) || 0,
    };
}

/**
 * Decode a NUL-terminated byte string (UDisks2 'ay') to a JS string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeByteString(bytes) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * Strip the '/dev/' prefix from a device path string coming from UDisks2
 * (which encodes them as byte arrays in GLib variants).
 * @param {GLib.Variant} byteArrayVariant
 * @returns {string}  e.g. "sdb"
 */
function devicePathToName(byteArrayVariant) {
    try {
        return decodeByteString(byteArrayVariant.deep_unpack()).replace('/dev/', '');
    } catch (_) {
        return '';
    }
}

// Fork addition: Filesystem.MountPoints is 'aay' (array of byte arrays).
// Returns the first decoded mount point, or null if not mounted.
function firstMountPoint(mountPointsVariant) {
    try {
        const arr = mountPointsVariant.deep_unpack();
        if (!arr || arr.length === 0) return null;
        const first = arr[0];
        const bytes = first instanceof Uint8Array ? first : first.deep_unpack();
        return decodeByteString(bytes) || null;
    } catch (_) {
        return null;
    }
}

// ─── Main Extension Class ─────────────────────────────────────────────────────

export default class TrueUsbProgressExtension extends Extension {

    // ── Lifecycle ──────────────────────────────────────────────────────────

    enable() {
        this._removableDevices = new Map();   // Map<devName, { label, mountPoint }>
        this._lastNotifyTime   = new Map();   // Map<devName, ms>
        this._pollSourceId     = null;
        this._enumerateSourceId = null;
        this._udisksSignalIds  = [];
        this._dbusConnection   = null;
        this._tickRunning      = false;
        this._cancellable      = new Gio.Cancellable();

        // Per-device I/O state + write-detection state machine
        // Map<devName, {
        //   prevWrites, prevSectors,      — cumulative counters from last tick
        //   totalBytesThisBurst,          — bytes written in current burst
        //   deltaBytesThisTick,           — bytes written this tick (for speed)
        //   wasWriting,                   — is this device in an active burst?
        //   idleTicks,                    — consecutive idle ticks
        //   lastRateMBs,                  — last known write speed string
        //   shownFraction,                — fork: highest fraction shown this burst
        // }>
        this._devStats         = new Map();

        // Fork addition: target-size tracking, per device.
        // Map<devName, {
        //   root,          — mount point being watched
        //   monitors,      — Map<dirPath, { monitor, sigId }>
        //   openFiles,     — Map<path, size> files still being written
        //   closedBytes,   — final sizes of files already closed
        //   lastEventAt,   — ms of last relevant file event
        // }>
        this._watches          = new Map();

        this._buildIndicator();
        this._connectUDisks2();
        this._startPolling();
    }

    disable() {
        this._cancellable.cancel();
        this._cancellable = null;

        this._stopPolling();
        this._disconnectUDisks2();
        for (const devName of [...this._watches.keys()])
            this._unwatchDevice(devName);
        this._destroyIndicator();

        this._watches          = null;
        this._removableDevices = null;
        this._devStats         = null;
        this._lastNotifyTime   = null;
    }

    // ── Indicator (PanelMenu.Button) ───────────────────────────────────────

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, true);

        // Container: icon + bar + label, horizontal (BoxLayout default)
        const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

        // Drive / USB icon
        this._icon = new St.Icon({
            icon_name   : 'drive-removable-media-usb-symbolic',
            style_class : 'system-status-icon',
        });

        // Progress text label
        this._label = new St.Label({
            text        : '',
            y_align     : Clutter.ActorAlign.CENTER,
            style       : 'margin-left: 4px; font-weight: bold;',
        });

        // Fork addition: graphical progress bar, shown only when at least
        // one active device has a known target size.
        this._barBg = new St.Widget({
            style: `width: ${BAR_WIDTH_PX}px; height: 8px; border-radius: 4px;
                    background-color: rgba(255,255,255,0.15); margin-left: 6px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._barFill = new St.Widget({
            style: 'width: 0px; height: 8px; border-radius: 4px; background-color: #3584e4;',
        });
        this._barBg.add_child(this._barFill);
        this._barBg.hide();

        box.add_child(this._icon);
        box.add_child(this._barBg);
        box.add_child(this._label);
        this._indicator.add_child(box);

        // Start hidden; shown only when USB writes are active
        this._indicator.hide();

        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    _destroyIndicator() {
        // Children are destroyed together with the indicator.
        this._indicator?.destroy();
        this._indicator = null;
        this._icon      = null;
        this._label     = null;
        this._barBg     = null;
        this._barFill   = null;
    }

    // ── UDisks2 D-Bus integration ──────────────────────────────────────────

    _connectUDisks2() {
        this._dbusConnection = Gio.DBus.system;
        if (!this._dbusConnection) {
            console.error('[TrueUsbProgress] Could not get system D-Bus connection');
            return;
        }

        // Initial enumeration of existing objects
        this._enumerateUDisks2Objects();

        const subscribe = (iface, member, arg0) => this._dbusConnection.signal_subscribe(
            UDISKS2_BUS_NAME,
            iface,
            member,
            null,
            arg0,
            Gio.DBusSignalFlags.NONE,
            () => this._scheduleEnumerate(),
        );

        // Watch for objects added / removed while extension is active
        this._udisksSignalIds.push(
            subscribe(DBUS_OBJMAN_IFACE, 'InterfacesAdded', null),
            subscribe(DBUS_OBJMAN_IFACE, 'InterfacesRemoved', null),
            // Fork addition: mounting/unmounting only changes the
            // Filesystem.MountPoints property, it doesn't add interfaces.
            subscribe(DBUS_PROPS_IFACE, 'PropertiesChanged', UDISKS2_FS),
        );
    }

    _disconnectUDisks2() {
        if (this._enumerateSourceId) {
            GLib.source_remove(this._enumerateSourceId);
            this._enumerateSourceId = null;
        }
        if (this._dbusConnection) {
            for (const id of this._udisksSignalIds)
                this._dbusConnection.signal_unsubscribe(id);
        }
        this._udisksSignalIds  = [];
        this._dbusConnection   = null;
    }

    // Fork addition: plugging a drive emits a flurry of signals; coalesce
    // them into a single GetManagedObjects call.
    _scheduleEnumerate() {
        if (this._enumerateSourceId) return;
        this._enumerateSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._enumerateSourceId = null;
            this._enumerateUDisks2Objects();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Call GetManagedObjects on UDisks2 to enumerate all current block devices
     * and find which ones are removable USB drives that are mounted.
     */
    _enumerateUDisks2Objects() {
        if (!this._dbusConnection) return;

        this._dbusConnection.call(
            UDISKS2_BUS_NAME,
            UDISKS2_OBJ_PATH,
            DBUS_OBJMAN_IFACE,
            'GetManagedObjects',
            null,
            new GLib.VariantType('(a{oa{sa{sv}}})'),
            Gio.DBusCallFlags.NONE,
            5000,
            this._cancellable,
            (conn, res) => {
                try {
                    const reply  = conn.call_finish(res);
                    const [objects] = reply.deep_unpack();
                    this._processUDisks2Objects(objects);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(e, '[TrueUsbProgress] GetManagedObjects failed');
                }
            },
        );
    }

    /**
     * Walk the UDisks2 object tree.  For each block device we check:
     *   1. Does it have a Block interface with a Drive property?
     *   2. Is that Drive removable with ConnectionBus == "usb"?
     *   3. Does it have a Filesystem interface?
     * If all true → add to _removableDevices with a human-readable label.
     *
     * Label priority:  filesystem label (IdLabel) → drive model → dev name.
     *
     * Fork addition: also reads Filesystem.MountPoints and reconciles the
     * per-device file watches accordingly.
     */
    _processUDisks2Objects(objects) {
        if (!this._removableDevices) return; // disabled meanwhile

        // Build a drive-path → { isUsb, model } map first
        const driveInfo = {};
        for (const [objPath, ifaces] of Object.entries(objects)) {
            if (!objPath.startsWith('/org/freedesktop/UDisks2/drives/')) continue;
            const driveIface = ifaces[UDISKS2_DRIVE];
            if (!driveIface) continue;
            const removable      = driveIface['Removable']?.deep_unpack()      ?? false;
            const connectionBus  = driveIface['ConnectionBus']?.deep_unpack()  ?? '';
            const model          = driveIface['Model']?.deep_unpack()          ?? '';
            driveInfo[objPath]   = {
                isUsb : removable && connectionBus === 'usb',
                model : model.trim(),
            };
        }

        // Now check block devices
        const newDevices = new Map();
        for (const [, ifaces] of Object.entries(objects)) {
            const blockIface = ifaces[UDISKS2_BLOCK];
            if (!blockIface) continue;

            const drivePath = blockIface['Drive']?.deep_unpack() ?? '/';
            const info      = driveInfo[drivePath];
            if (!info?.isUsb) continue;

            // Must have a Filesystem interface (partitions without one are ignored)
            const fsIface = ifaces[UDISKS2_FS];
            if (!fsIface) continue;

            const devVariant = blockIface['Device'];
            if (!devVariant) continue;
            const devName = devicePathToName(devVariant);
            if (!devName) continue;

            // Pick the best human-readable label
            const fsLabel = blockIface['IdLabel']?.deep_unpack()?.trim() ?? '';
            const label   = fsLabel || info.model || devName;

            const mountPoint = fsIface['MountPoints']
                ? firstMountPoint(fsIface['MountPoints'])
                : null;

            newDevices.set(devName, { label, mountPoint });
        }

        // Fork addition: drop state of devices that went away, so a
        // re-plugged stick doesn't resume a stale burst.
        for (const devName of [...this._devStats.keys()]) {
            if (!newDevices.has(devName))
                this._devStats.delete(devName);
        }

        this._removableDevices = newDevices;
        this._reconcileWatches();
    }

    // ── Fork addition: file watching for target-size detection ─────────────
    //
    // Files created on the drive (in the mount root, or in directories
    // created during the transfer) are tracked. Open files have their size
    // re-read every tick; once closed (CHANGES_DONE_HINT) their final size
    // moves into closedBytes. The sum is what the copy has written so far,
    // i.e. what must eventually be flushed to the device.
    //
    // Not tracked: files moved in from elsewhere on the same drive (no data
    // is written), pre-existing directories other than the mount root, and
    // hidden directories (e.g. .Trash-1000).

    _reconcileWatches() {
        for (const [devName, watch] of [...this._watches]) {
            if (this._removableDevices.get(devName)?.mountPoint !== watch.root)
                this._unwatchDevice(devName);
        }

        for (const [devName, info] of this._removableDevices) {
            if (info.mountPoint && !this._watches.has(devName))
                this._watchDevice(devName, info.mountPoint);
        }
    }

    _watchDevice(devName, mountPoint) {
        this._watches.set(devName, {
            root        : mountPoint,
            monitors    : new Map(),
            openFiles   : new Map(),
            closedBytes : 0,
            lastEventAt : 0,
        });
        this._addDirMonitor(devName, Gio.File.new_for_path(mountPoint));
    }

    _unwatchDevice(devName) {
        const watch = this._watches.get(devName);
        if (!watch) return;
        for (const path of [...watch.monitors.keys()])
            this._removeDirMonitor(watch, path);
        this._watches.delete(devName);
    }

    _addDirMonitor(devName, dir) {
        const watch = this._watches.get(devName);
        const path  = dir.get_path();
        if (!watch || watch.monitors.has(path) ||
            watch.monitors.size >= MAX_WATCHED_DIRS_PER_DEVICE)
            return false;

        try {
            const monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            const sigId = monitor.connect('changed', (_mon, file, otherFile, eventType) => {
                this._onFileEvent(devName, file, otherFile, eventType);
            });
            watch.monitors.set(path, { monitor, sigId });
            return true;
        } catch (e) {
            console.error(e, `[TrueUsbProgress] Could not watch ${path}`);
            return false;
        }
    }

    _removeDirMonitor(watch, path) {
        const entry = watch.monitors.get(path);
        if (!entry) return;
        entry.monitor.disconnect(entry.sigId);
        entry.monitor.cancel();
        watch.monitors.delete(path);
    }

    // Forget all target files and the per-transfer directory monitors,
    // keeping only the mount-root monitor.
    _resetTargets(devName) {
        const watch = this._watches.get(devName);
        if (!watch) return;
        watch.openFiles.clear();
        watch.closedBytes = 0;
        for (const path of [...watch.monitors.keys()]) {
            if (path !== watch.root)
                this._removeDirMonitor(watch, path);
        }
    }

    _targetSize(devName) {
        const watch = this._watches.get(devName);
        if (!watch) return 0;
        let total = watch.closedBytes;
        for (const size of watch.openFiles.values())
            total += size;
        return total;
    }

    _onFileEvent(devName, file, otherFile, eventType) {
        const watch = this._watches?.get(devName);
        if (!watch) return;
        const path = file.get_path();

        switch (eventType) {
        case Gio.FileMonitorEvent.CREATED:
            watch.lastEventAt = Date.now();
            // Register synchronously so a quick CHANGES_DONE_HINT isn't
            // missed while the type query below is still in flight.
            if (watch.openFiles.size < MAX_OPEN_FILES_PER_DEVICE)
                watch.openFiles.set(path, 0);
            this._classifyCreated(devName, file).catch(logUnexpected);
            break;

        case Gio.FileMonitorEvent.CHANGES_DONE_HINT:
            if (watch.openFiles.has(path)) {
                watch.lastEventAt = Date.now();
                this._finalizeFile(devName, file).catch(logUnexpected);
            }
            break;

        case Gio.FileMonitorEvent.RENAMED:
            // e.g. GIO's ".goutputstream-XXXXXX" temp file renamed over the
            // destination when replacing an existing file.
            if (otherFile && watch.openFiles.has(path)) {
                const size = watch.openFiles.get(path);
                watch.openFiles.delete(path);
                watch.openFiles.set(otherFile.get_path(), size);
            }
            break;

        case Gio.FileMonitorEvent.DELETED:
        case Gio.FileMonitorEvent.MOVED_OUT:
            watch.openFiles.delete(path);
            if (path !== watch.root)
                this._removeDirMonitor(watch, path);
            break;
        }
    }

    async _classifyCreated(devName, file) {
        let info;
        try {
            info = await file.query_info_async('standard::type,standard::size',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT,
                this._cancellable);
        } catch (_) {
            this._watches?.get(devName)?.openFiles.delete(file.get_path());
            return;
        }

        const watch = this._watches?.get(devName);
        if (!watch) return;
        const path = file.get_path();
        const type = info.get_file_type();

        if (type === Gio.FileType.REGULAR) {
            if (watch.openFiles.has(path))
                watch.openFiles.set(path, info.get_size());
            return;
        }

        watch.openFiles.delete(path);
        if (type === Gio.FileType.DIRECTORY && !file.get_basename().startsWith('.') &&
            this._addDirMonitor(devName, file))
            await this._scanNewDir(devName, file);
    }

    // A directory created by the copy may already contain files (or
    // subdirectories) by the time its monitor is attached.
    async _scanNewDir(devName, dir) {
        let enumerator;
        try {
            enumerator = await dir.enumerate_children_async('standard::name,standard::type,standard::size',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT,
                this._cancellable);
        } catch (_) {
            return;
        }

        try {
            for (;;) {
                const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT,
                    this._cancellable);
                if (infos.length === 0) break;

                const watch = this._watches?.get(devName);
                if (!watch) return;

                for (const info of infos) {
                    const child = dir.get_child(info.get_name());
                    const type  = info.get_file_type();
                    if (type === Gio.FileType.REGULAR) {
                        if (watch.openFiles.size < MAX_OPEN_FILES_PER_DEVICE)
                            watch.openFiles.set(child.get_path(), info.get_size());
                    } else if (type === Gio.FileType.DIRECTORY &&
                               !info.get_name().startsWith('.') &&
                               this._addDirMonitor(devName, child)) {
                        await this._scanNewDir(devName, child);
                    }
                }
            }
        } catch (_) {
            // directory vanished or extension disabled
        } finally {
            enumerator.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        }
    }

    async _finalizeFile(devName, file) {
        const size = await this._querySize(file);
        const watch = this._watches?.get(devName);
        const path = file.get_path();
        if (!watch || !watch.openFiles.has(path)) return;

        const finalSize = size ?? watch.openFiles.get(path);
        watch.openFiles.delete(path);
        watch.closedBytes += finalSize;
    }

    async _querySize(file) {
        try {
            const info = await file.query_info_async('standard::size',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT,
                this._cancellable);
            return info.get_size();
        } catch (_) {
            return null;
        }
    }

    // Re-read the current size of files that are still being written.
    async _refreshOpenFiles(devName) {
        const watch = this._watches.get(devName);
        if (!watch || watch.openFiles.size === 0) return;

        const paths = [...watch.openFiles.keys()].slice(0, MAX_SIZE_QUERIES_PER_TICK);
        const sizes = await Promise.all(
            paths.map(p => this._querySize(Gio.File.new_for_path(p))));

        if (this._watches?.get(devName) !== watch) return;
        paths.forEach((p, i) => {
            if (sizes[i] !== null && watch.openFiles.has(p))
                watch.openFiles.set(p, sizes[i]);
        });
    }

    // ── Polling ────────────────────────────────────────────────────────────

    _startPolling() {
        this._pollSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            POLL_INTERVAL_SECONDS,
            () => {
                // Fork addition: never run two ticks concurrently (slow
                // async reads could otherwise interleave state updates).
                if (!this._tickRunning) {
                    this._tickRunning = true;
                    this._tick()
                        .catch(logUnexpected)
                        .finally(() => { this._tickRunning = false; });
                }
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    _stopPolling() {
        if (this._pollSourceId !== null) {
            GLib.source_remove(this._pollSourceId);
            this._pollSourceId = null;
        }
    }

    /**
     * Called every POLL_INTERVAL_SECONDS.
     *
     * Each USB device runs its own independent two-phase state machine:
     *
     *   TRIGGER (Phase 1) — strict thresholds on write rate AND average I/O
     *     size.  Only large sequential writes (file copies) can start a burst.
     *     Small metadata writes are ignored.
     *
     *   SUSTAIN (Phase 2) — once triggered, ANY device write activity
     *     (even small) keeps the device's indicator alive.  This prevents
     *     flickering between writeback bursts during an active copy.
     *
     *   DONE — a device's burst ends only after it is truly idle
     *     (zero sector changes AND zero in-flight I/O) for
     *     IDLE_TICKS_BEFORE_DONE consecutive ticks.  A notification fires
     *     naming only that specific device.
     */
    async _tick() {
        if (!this._indicator) return;                  // extension disabled mid-tick

        if (this._removableDevices.size === 0) {
            this._indicator.hide();
            return;
        }

        const cancellable = this._cancellable;
        const devices = [...this._removableDevices];

        // Read all counters (and refresh open target files) in parallel
        const allStats = await Promise.all(devices.map(async ([dev]) => {
            const [stats] = await Promise.all([
                getBlockWriteStats(dev, cancellable),
                this._refreshOpenFiles(dev),
            ]);
            return stats;
        }));

        // Guard: extension may have been disabled during the async reads
        if (!this._indicator) return;

        // Names of devices that just finished their burst this tick
        const justFinished = [];
        const now = Date.now();

        // ── 1. Per-device delta analysis + state machine ──────────────────
        devices.forEach(([dev, devInfo], i) => {
            const stats = allStats[i];
            if (!stats) return;

            let st = this._devStats.get(dev);

            if (!st) {
                // First time seeing this device — store baseline
                this._devStats.set(dev, {
                    prevWrites         : stats.writesCompleted,
                    prevSectors        : stats.sectorsWritten,
                    totalBytesThisBurst: 0,
                    deltaBytesThisTick : 0,
                    wasWriting         : false,
                    idleTicks          : 0,
                    lastRateMBs        : '0.0',
                    shownFraction      : 0,
                });
                return;
            }

            const deltaWrites  = stats.writesCompleted - st.prevWrites;
            const deltaSectors = stats.sectorsWritten  - st.prevSectors;
            const deltaBytes   = deltaSectors * 512;
            const inFlight     = stats.inFlight > 0;

            // Update cumulative counters
            st.prevWrites  = stats.writesCompleted;
            st.prevSectors = stats.sectorsWritten;

            // Classify activity for this device
            const hasActivity   = deltaWrites > 0 && deltaSectors > 0;
            const avgIOSize     = hasActivity ? deltaBytes / deltaWrites : 0;
            const isLargeWrite  = hasActivity &&
                                  deltaBytes >= MIN_WRITE_RATE_BYTES &&
                                  avgIOSize  >= MIN_AVG_IO_SIZE_BYTES;

            // Track this tick's delta for speed display
            st.deltaBytesThisTick = hasActivity ? deltaBytes : 0;

            // ── Per-device state machine ───────────────────────────────────
            if (!st.wasWriting) {
                // Phase 1: only large writes can start a burst
                if (isLargeWrite) {
                    st.wasWriting = true;
                    st.idleTicks  = 0;
                } else {
                    // Fork addition: forget target files whose writes never
                    // turned into a burst.
                    const watch = this._watches.get(dev);
                    if (watch && now - watch.lastEventAt > TARGET_STALE_MS)
                        this._resetTargets(dev);
                }
            } else {
                // Phase 2: any activity or in-flight keeps it alive
                if (hasActivity || inFlight) {
                    st.idleTicks = 0;
                } else {
                    st.idleTicks++;
                    if (st.idleTicks >= IDLE_TICKS_BEFORE_DONE) {
                        // This device is DONE
                        st.wasWriting          = false;
                        st.idleTicks           = 0;
                        st.totalBytesThisBurst = 0;
                        st.lastRateMBs         = '0.0';
                        st.shownFraction       = 0;
                        // Fork addition: clear targets too, so the next
                        // transfer starts fresh.
                        this._resetTargets(dev);
                        justFinished.push({ dev, label: devInfo.label });
                    }
                }
            }

            // Fork change: only count bytes while a burst is active, so idle
            // metadata writes don't accumulate into the next burst's total.
            if (st.wasWriting && hasActivity)
                st.totalBytesThisBurst += deltaBytes;

            // Update speed string when we have fresh data
            if (st.deltaBytesThisTick > 0) {
                st.lastRateMBs = (st.deltaBytesThisTick / (1024 * 1024) / POLL_INTERVAL_SECONDS).toFixed(1);
            }
        });

        // ── 2. Fire notifications for any devices that just finished ──────
        for (const { dev, label } of justFinished) {
            this._notifySyncComplete(dev, label);
        }

        // ── 3. Build indicator from all devices currently writing ─────────
        const parts = [];
        let barWritten = 0;
        let barTotal   = 0;

        for (const [dev, devInfo] of this._removableDevices) {
            const st = this._devStats.get(dev);
            if (!st?.wasWriting) continue;

            const mb = (st.totalBytesThisBurst / (1024 * 1024)).toFixed(1);
            const rateSuffix = st.deltaBytesThisTick > 0 ? ` (${st.lastRateMBs} MB/s)` : '';
            const targetSize = this._targetSize(dev);

            // Fork addition: include a percentage when the target size is
            // known, otherwise fall back to the original "MB (rate)" text.
            if (targetSize > 0) {
                const fraction = Math.min(MAX_SHOWN_FRACTION, st.totalBytesThisBurst / targetSize);
                // The total can grow while a multi-file copy is still filling
                // the page cache; don't let the shown percentage go backwards.
                st.shownFraction = Math.max(st.shownFraction, fraction);
                const pct = Math.floor(st.shownFraction * 100);
                const totalMb = (targetSize / (1024 * 1024)).toFixed(0);
                parts.push(`${devInfo.label}: ${pct}% · ${mb}/${totalMb} MB${rateSuffix}`);
                barWritten += st.shownFraction * targetSize;
                barTotal   += targetSize;
            } else {
                parts.push(`${devInfo.label}: ${mb} MB${rateSuffix}`);
            }
        }

        if (parts.length > 0) {
            this._label.set_text(parts.join(' · '));

            // Fork addition: graphical bar shows combined progress of the
            // active devices with a known target; hidden if none.
            if (barTotal > 0) {
                const width = Math.round(BAR_WIDTH_PX * barWritten / barTotal);
                this._barFill.set_style(
                    `width: ${width}px; height: 8px; border-radius: 4px; background-color: #3584e4;`);
                this._barBg.show();
            } else {
                this._barBg.hide();
            }

            this._indicator.show();
        } else {
            this._barBg.hide();
            this._indicator.hide();
        }
    }

    // ── Notification ───────────────────────────────────────────────────────

    /**
     * Notify the user that a specific USB drive has finished syncing.
     * @param {string} devName    Device name, used for the per-device cooldown
     * @param {string} driveName  Human-readable label of the drive
     */
    _notifySyncComplete(devName, driveName) {
        const now = GLib.get_monotonic_time() / 1000; // µs → ms
        if (now - (this._lastNotifyTime.get(devName) ?? -Infinity) < NOTIFY_COOLDOWN_MS) return;
        this._lastNotifyTime.set(devName, now);

        Main.notify(
            'USB Sync Complete',
            `Write cache flushed — safe to eject ${driveName}.`,
        );
    }
}

function logUnexpected(e) {
    if (!e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        console.error(e, '[TrueUsbProgress] Unexpected error');
}
