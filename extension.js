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
 * Fork additions:
 *  • Gio.FileMonitor on each mount point (and directories created during a
 *    transfer) sums the sizes of the files being written there. Bytes
 *    actually flushed to the device divided by that total gives a real
 *    percentage. Falls back to a plain "N MB" display when no target files
 *    are known.
 *  • "Done" is only declared once the data is really on the device: the
 *    flushed byte count reached the target, or the system has no dirty
 *    data left, or the kernel's dirty-expire window has passed.
 *  • Compact panel item (icon, bar, percentage) with a details menu and a
 *    "Flush now" action (syncfs on the mount point, no root needed).
 *  • LUKS volumes are resolved to their physical USB drive.
 */

import GLib     from 'gi://GLib';
import Gio      from 'gi://Gio';
import St       from 'gi://St';
import Clutter  from 'gi://Clutter';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main       from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu  from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu  from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Config     from 'resource:///org/gnome/shell/misc/config.js';

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
//     Fork addition: a burst also starts as soon as files being copied to the
//     drive add up to TARGET_TRIGGER_BYTES, before the kernel writes anything.
//
//   Phase 2 — SUSTAIN:  Once triggered, ANY device write activity (even small)
//     keeps the indicator alive.  This prevents the indicator from flickering
//     off between kernel writeback bursts during an active copy.
//
//   DONE:  Only when the device is truly idle (zero sector change AND zero
//     in-flight I/O) for a sustained period do we declare the copy finished.
//     Fork change: and only if the data is known to be on the device (see
//     _looksComplete), or the kernel's dirty-expire window has passed.

// Phase 1 thresholds (must pass BOTH to trigger)
const MIN_WRITE_RATE_BYTES  = 64 * 1024;  // 64 KB per tick (~32 KB/s @2s poll)
const MIN_AVG_IO_SIZE_BYTES = 16 * 1024;  // 16 KB avg request size

// How many consecutive "truly idle" ticks (no sector change, no in-flight)
// before declaring the write finished.  Linux writeback is bursty, so we need
// a generous window to avoid premature "done" between flush rounds.
// 5 ticks × 2 seconds = 10 second grace period.
const IDLE_TICKS_BEFORE_DONE = 5;

// Fork addition: when the data is not known to be flushed, wait at least for
// the kernel's dirty_expire + dirty_writeback interval (plus margin) before
// declaring DONE. Defaults match the kernel's (30 s + 5 s).
const DEFAULT_DIRTY_EXPIRE_MS    = 30_000;
const DEFAULT_DIRTY_WRITEBACK_MS = 5_000;
const EXPIRE_MARGIN_MS           = 6_000;
// With no target size known, the burst is considered flushed when the whole
// system has at most this much dirty + writeback data left.
const SYSTEM_PENDING_SAFE_BYTES  = 64 * 1024 * 1024;
// Slack between flushed bytes and target size (rounding of the last blocks).
const COMPLETE_SLACK_BYTES       = 1024 * 1024;

// Fork addition: target-file tracking limits.
const MAX_WATCHED_DIRS_PER_DEVICE = 32;     // root + directories created during a copy
const MAX_OPEN_FILES_PER_DEVICE   = 256;    // files still being written
const MAX_SIZE_QUERIES_PER_TICK   = 64;
// Forget target files if no write burst started this long after the last file
// event (e.g. small files whose writes never passed the trigger thresholds).
const TARGET_STALE_MS = 120_000;
// A burst starts as soon as this much data is being copied to the drive.
const TARGET_TRIGGER_BYTES = 4 * 1024 * 1024;
// An open target file whose size changed this recently is still being
// written by the copy: never declare DONE meanwhile. Files that stop growing
// without a close event (missed CHANGES_DONE_HINT) stop blocking after this.
const OPEN_FILE_ACTIVE_MS = 15_000;
// Never show 100% while the indicator is still up: filesystem metadata makes
// the device byte count overshoot the data size slightly before DONE.
const MAX_SHOWN_FRACTION = 0.99;

// Fork addition: UI.
const PANEL_BAR_WIDTH_PX = 64;
const FADE_MS            = 200;
// Duration of each bar movement: constant, so speed ∝ distance covered.
const BAR_ANIM_MS        = 1_500;
const DONE_DISPLAY_MS    = 3_500;  // how long the "done" check stays visible

// UDisks2 well-known names
const UDISKS2_BUS_NAME  = 'org.freedesktop.UDisks2';
const UDISKS2_OBJ_PATH  = '/org/freedesktop/UDisks2';
const DBUS_OBJMAN_IFACE = 'org.freedesktop.DBus.ObjectManager';
const DBUS_PROPS_IFACE  = 'org.freedesktop.DBus.Properties';
const UDISKS2_BLOCK     = 'org.freedesktop.UDisks2.Block';
const UDISKS2_DRIVE     = 'org.freedesktop.UDisks2.Drive';
const UDISKS2_FS        = 'org.freedesktop.UDisks2.Filesystem';

const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION, 10) || 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Promisify Gio async methods for async/await usage
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async');

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

// Fork addition: system-wide data not yet on disk (Dirty + Writeback), in
// bytes, or null if unreadable.
async function getSystemPendingBytes(cancellable) {
    const text = await readFileAsync('/proc/meminfo', cancellable);
    if (!text) return null;
    let kb = 0;
    for (const m of text.matchAll(/^(?:Dirty|Writeback):\s+(\d+) kB$/gm))
        kb += parseInt(m[1], 10);
    return kb * 1024;
}

// Fork addition: read a /proc/sys/vm centisecond tunable, in ms.
async function readCentisecs(name, fallbackMs, cancellable) {
    const text = await readFileAsync(`/proc/sys/vm/${name}`, cancellable);
    const cs = parseInt(text, 10);
    return Number.isFinite(cs) && cs >= 0 ? cs * 10 : fallbackMs;
}

// Fork addition: left-pad with FIGURE SPACE (U+2007), which is as wide as a
// tabular digit, so numbers of different lengths occupy the same width.
function padFigures(value, len) {
    return String(value).padStart(len, ' ');
}

// Fork addition: bytes a file really has to write. Sparse or preallocated
// files (fallocate, torrent clients) report a large apparent size with few
// blocks behind it; take the smaller of the two when the FS reports blocks.
const SIZE_ATTRS = 'standard::size,standard::allocated-size';
function dataSize(info) {
    const size  = info.get_size();
    const alloc = info.get_attribute_uint64('standard::allocated-size');
    return alloc > 0 ? Math.min(size, alloc) : size;
}

// Per-device I/O state, starting from a baseline reading of its counters.
function newDevStats(stats) {
    return {
        prevWrites         : stats.writesCompleted,
        prevSectors        : stats.sectorsWritten,
        totalBytesThisBurst: 0,
        deltaBytesThisTick : 0,
        wasWriting         : false,
        idleTicks          : 0,
        lastRateMBs        : '0.0',
        shownFraction      : 0,
    };
}

// Fork addition: monotonic milliseconds (immune to wall-clock/NTP jumps).
function nowMs() {
    return GLib.get_monotonic_time() / 1000;
}

// Fork addition: human-readable size, e.g. "512 MB", "1.45 GB".
function formatBytes(bytes) {
    const mb = bytes / (1024 * 1024);
    if (mb < 1000) return `${Math.round(mb)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
}

// Fork addition: St.BoxLayout got 'orientation' in GNOME 48 and deprecated
// 'vertical'; support both.
function makeVBox(params = {}) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
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

// Fork addition: a progress track with an eased fill, used in the panel
// (fixed width) and in the menu (stretched to the row). The fill width is an
// actor property (not CSS) so it can be animated.
class ProgressBar {
    // widthPx: fixed track width, or null to fill the parent's width.
    constructor(widthPx, styleClass) {
        this._widthPx  = widthPx;
        this._fraction = 0;
        this._idleId   = 0;
        this._allocId  = 0;
        const fixed = widthPx !== null;
        this.actor = new St.Widget({
            style_class : `tup-bar ${styleClass}`,
            style       : fixed ? `width: ${widthPx}px;` : null,
            // A fixed track is never stretched by its parent, so a full fill
            // always reaches its end.
            x_align     : fixed ? Clutter.ActorAlign.START : Clutter.ActorAlign.FILL,
            x_expand    : !fixed,
            y_align     : Clutter.ActorAlign.CENTER,
        });
        this._fill = new St.Widget({ style_class: 'tup-bar-fill', width: 0 });
        if (SHELL_MAJOR >= 47)
            this._fill.add_style_class_name('tup-accent');
        this.actor.add_child(this._fill);

        // A stretched track only knows its width after layout. Resizing the
        // fill during an allocation would queue a relayout inside it, so
        // re-apply the fraction from an idle callback instead.
        if (!fixed) {
            this._allocId = this.actor.connect('notify::allocation', () => {
                if (this._idleId) return;
                this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._idleId = 0;
                    const target = this._targetWidth(this._fraction);
                    if (Math.abs(this._fill.width - target) > 1)
                        this.setFraction(this._fraction, 0);
                    return GLib.SOURCE_REMOVE;
                });
            });
        }
    }

    _targetWidth(fraction) {
        const track = this._widthPx ??
            (this.actor.has_allocation() ? this.actor.allocation.get_width() : 0);
        return Math.round(track * Math.max(0, Math.min(1, fraction)));
    }

    // Glide to the new value over `duration` ms; 0 jumps immediately.
    setFraction(fraction, duration) {
        this._fraction = fraction;
        const width = this._targetWidth(fraction);
        if (duration <= 0) {
            this._fill.remove_all_transitions();
            this._fill.width = width;
            return;
        }
        this._fill.ease({
            width,
            duration,
            mode: Clutter.AnimationMode.LINEAR,
        });
    }

    setDone(done) {
        if (done)
            this._fill.add_style_class_name('tup-done');
        else
            this._fill.remove_style_class_name('tup-done');
    }

    destroy() {
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        if (this._allocId) {
            this.actor.disconnect(this._allocId);
            this._allocId = 0;
        }
        this._fill?.destroy();
        this.actor?.destroy();
        this._fill = null;
        this.actor = null;
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
        this._doneSourceId     = null;
        this._fadingOut        = false;
        this._needsReset       = false;
        this._systemPending    = null;
        this._udisksSignalIds  = [];
        this._dbusConnection   = null;
        this._tickRunning      = false;
        this._cancellable      = new Gio.Cancellable();
        this._maxIdleMs        = DEFAULT_DIRTY_EXPIRE_MS + DEFAULT_DIRTY_WRITEBACK_MS +
                                 EXPIRE_MARGIN_MS;

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
        //   openFiles,     — Map<path, { size, changedAt }> files still being written
        //   closedBytes,   — final sizes of files already closed
        //   lastEventAt,   — ms of last relevant file event
        // }>
        this._watches          = new Map();

        // Fork addition: menu rows of the devices currently shown.
        this._menuRows         = new Map();

        this._buildIndicator();
        this._readKernelTunables();
        this._connectUDisks2();
        this._startPolling();
    }

    disable() {
        this._cancellable.cancel();
        this._cancellable = null;

        this._stopPolling();
        this._disconnectUDisks2();
        if (this._doneSourceId) {
            GLib.source_remove(this._doneSourceId);
            this._doneSourceId = null;
        }
        for (const devName of [...this._watches.keys()])
            this._unwatchDevice(devName);
        this._destroyIndicator();

        this._watches          = null;
        this._removableDevices = null;
        this._devStats         = null;
        this._lastNotifyTime   = null;
        this._menuRows         = null;
    }

    async _readKernelTunables() {
        const cancellable = this._cancellable;
        const [expire, writeback] = await Promise.all([
            readCentisecs('dirty_expire_centisecs', DEFAULT_DIRTY_EXPIRE_MS, cancellable),
            readCentisecs('dirty_writeback_centisecs', DEFAULT_DIRTY_WRITEBACK_MS, cancellable),
        ]);
        if (this._cancellable !== cancellable) return;
        // dirty_writeback_centisecs = 0 disables periodic writeback: expired
        // data is never flushed on its own, so there is no safe timeout.
        this._maxIdleMs = writeback > 0 && expire > 0
            ? expire + writeback + EXPIRE_MARGIN_MS
            : Infinity;
    }

    // ── Indicator (PanelMenu.Button) ───────────────────────────────────────

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        // Container: icon + bar + label, horizontal (BoxLayout default)
        const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

        // Drive / USB icon
        this._icon = new St.Icon({
            icon_name   : 'drive-removable-media-usb-symbolic',
            style_class : 'system-status-icon',
        });

        // Fork addition: graphical progress bar, shown only when at least
        // one active device has a known target size.
        this._panelBar = new ProgressBar(PANEL_BAR_WIDTH_PX, 'tup-bar-panel');
        this._panelBar.actor.hide();

        // Progress text label (percentage, or MB when no target is known)
        this._label = new St.Label({
            text        : '',
            y_align     : Clutter.ActorAlign.CENTER,
            style_class : 'tup-panel-label',
        });

        box.add_child(this._icon);
        box.add_child(this._panelBar.actor);
        box.add_child(this._label);
        this._indicator.add_child(box);

        // Fork addition: details menu.
        this._rowsSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._rowsSection);
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._flushItem = new PopupMenu.PopupMenuItem(_('Flush now'));
        this._flushItem.connect('activate', () => this._flushNow().catch(logUnexpected));
        this._indicator.menu.addMenuItem(this._flushItem);

        // Start hidden; shown only when USB writes are active
        this._indicator.hide();

        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    _destroyIndicator() {
        this._removeMenuRows();
        this._flushItem?.destroy();
        this._rowsSection?.destroy();
        this._panelBar?.destroy();
        this._icon?.destroy();
        this._label?.destroy();
        this._indicator?.destroy();
        this._indicator   = null;
        this._icon        = null;
        this._label       = null;
        this._panelBar    = null;
        this._rowsSection = null;
        this._flushItem   = null;
    }

    _showIndicator() {
        const ind = this._indicator;
        if (ind.visible && ind.opacity === 255 && !this._fadingOut) return;
        ind.remove_all_transitions();   // cancels a fade-out in progress
        this._needsReset = true;
        if (!ind.visible) {
            ind.opacity = 0;
            ind.show();
        }
        ind.ease({ opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    _hideIndicator() {
        const ind = this._indicator;
        if (!ind.visible) {
            this._resetIndicator();
            return;
        }
        if (this._fadingOut) return;
        this._fadingOut = true;
        ind.menu.close();
        ind.remove_all_transitions();
        ind.ease({
            opacity    : 0,
            duration   : FADE_MS,
            mode       : Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped  : () => { this._fadingOut = false; },
            onComplete : () => {
                ind.hide();
                this._resetIndicator();
            },
        });
    }

    // Back to the idle look, ready for the next burst. Only while hidden.
    _resetIndicator() {
        if (!this._indicator || !this._needsReset) return;
        this._needsReset = false;
        this._removeMenuRows();
        this._panelBar.actor.hide();
        this._panelBar.setDone(false);
        this._panelBar.setFraction(0, 0);
        this._icon.icon_name = 'drive-removable-media-usb-symbolic';
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

            // Fork addition: an unlocked LUKS volume (dm-N) has no Drive of
            // its own; follow CryptoBackingDevice to the physical device.
            let drivePath = blockIface['Drive']?.deep_unpack() ?? '/';
            const backing = blockIface['CryptoBackingDevice']?.deep_unpack() ?? '/';
            if (drivePath === '/' && backing !== '/')
                drivePath = objects[backing]?.[UDISKS2_BLOCK]?.['Drive']?.deep_unpack() ?? '/';
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

        // Fork addition: take the I/O baseline right away instead of on the
        // next tick, so writes in the first seconds after mounting count.
        for (const devName of newDevices.keys()) {
            if (!this._devStats.has(devName))
                this._initBaseline(devName).catch(logUnexpected);
        }
    }

    async _initBaseline(devName) {
        const cancellable = this._cancellable;
        const stats = await getBlockWriteStats(devName, cancellable);
        if (!stats || this._cancellable !== cancellable ||
            !this._removableDevices?.has(devName) || this._devStats.has(devName))
            return;
        this._devStats.set(devName, newDevStats(stats));
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
        for (const { size } of watch.openFiles.values())
            total += size;
        return total;
    }

    // True while the copy is still producing data for this device.
    _hasActiveWriters(devName, now) {
        const watch = this._watches.get(devName);
        if (!watch) return false;
        for (const { changedAt } of watch.openFiles.values()) {
            if (now - changedAt < OPEN_FILE_ACTIVE_MS)
                return true;
        }
        return false;
    }

    // Entries are updated in place, so code holding an entry across an
    // await still finds it after a RENAMED moved it to another key.
    _setOpenFile(watch, path, size) {
        const prev = watch.openFiles.get(path);
        if (prev) {
            if (prev.size !== size) {
                prev.size = size;
                prev.changedAt = nowMs();
            }
            return;
        }
        if (watch.openFiles.size >= MAX_OPEN_FILES_PER_DEVICE) return;
        watch.openFiles.set(path, { size, changedAt: nowMs() });
    }

    // Move an open entry to closedBytes. Looks the entry up by identity:
    // it may have been renamed meanwhile.
    _closeEntry(watch, entry, size) {
        for (const [p, e] of watch.openFiles) {
            if (e === entry) {
                watch.openFiles.delete(p);
                watch.closedBytes += size ?? entry.size;
                return;
            }
        }
    }

    _onFileEvent(devName, file, otherFile, eventType) {
        const watch = this._watches?.get(devName);
        if (!watch) return;
        const path = file.get_path();

        switch (eventType) {
        case Gio.FileMonitorEvent.CREATED:
            watch.lastEventAt = nowMs();
            // Register synchronously so a quick CHANGES_DONE_HINT isn't
            // missed while the type query below is still in flight.
            if (!watch.openFiles.has(path))
                this._setOpenFile(watch, path, 0);
            this._classifyCreated(devName, file).catch(logUnexpected);
            break;

        case Gio.FileMonitorEvent.CHANGES_DONE_HINT:
            if (watch.openFiles.has(path)) {
                watch.lastEventAt = nowMs();
                this._finalizeFile(devName, file).catch(logUnexpected);
            }
            break;

        case Gio.FileMonitorEvent.RENAMED:
            // e.g. GIO's ".goutputstream-XXXXXX" temp file renamed over the
            // destination when replacing an existing file.
            if (otherFile && watch.openFiles.has(path)) {
                const entry = watch.openFiles.get(path);
                watch.openFiles.delete(path);
                watch.openFiles.set(otherFile.get_path(), entry);
                watch.lastEventAt = nowMs();
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
            info = await file.query_info_async(`standard::type,${SIZE_ATTRS}`,
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
                this._setOpenFile(watch, path, dataSize(info));
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
            enumerator = await dir.enumerate_children_async(`standard::name,standard::type,${SIZE_ATTRS}`,
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
                        this._setOpenFile(watch, child.get_path(), dataSize(info));
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
        const watch = this._watches?.get(devName);
        const entry = watch?.openFiles.get(file.get_path());
        if (!entry) return;
        const size = await this._querySize(file);
        if (this._watches?.get(devName) !== watch) return;
        // If a RENAMED moved the entry during the query, the old path no
        // longer exists (size null): keep the last known size.
        this._closeEntry(watch, entry, size);
    }

    async _querySize(file) {
        try {
            const info = await file.query_info_async(SIZE_ATTRS,
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT,
                this._cancellable);
            return dataSize(info);
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
                this._setOpenFile(watch, p, sizes[i]);
        });

        // Files that stopped growing are done even without a close event
        // (e.g. already closed when _scanNewDir found them); this also keeps
        // big tree copies from filling MAX_OPEN_FILES_PER_DEVICE.
        const now = nowMs();
        for (const entry of [...watch.openFiles.values()]) {
            if (now - entry.changedAt >= OPEN_FILE_ACTIVE_MS)
                this._closeEntry(watch, entry, null);
        }
    }

    // ── Fork addition: "Flush now" ─────────────────────────────────────────

    // syncfs() every mounted removable filesystem with a burst in progress.
    // Unprivileged: sync -f only needs read access to the mount point.
    async _flushNow() {
        const cancellable = this._cancellable;
        const mounts = [];
        for (const [dev, info] of this._removableDevices) {
            if (this._devStats.get(dev)?.wasWriting && info.mountPoint)
                mounts.push(info.mountPoint);
        }
        if (mounts.length === 0) return;

        await Promise.all(mounts.map(async mount => {
            try {
                const proc = Gio.Subprocess.new(['sync', '-f', mount],
                    Gio.SubprocessFlags.STDERR_SILENCE);
                await proc.wait_check_async(cancellable);
            } catch (e) {
                logUnexpected(e);
            }
        }));
    }

    // ── Polling ────────────────────────────────────────────────────────────

    _startPolling() {
        const cancellable = this._cancellable;
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
                        .finally(() => {
                            // Only clear the flag of the enable() that set it.
                            if (this._cancellable === cancellable)
                                this._tickRunning = false;
                        });
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
     *     Small metadata writes are ignored.  Fork addition: or enough data
     *     being copied to the drive's filesystem (still in the page cache).
     *
     *   SUSTAIN (Phase 2) — once triggered, ANY device write activity
     *     (even small) keeps the device's indicator alive.  This prevents
     *     flickering between writeback bursts during an active copy.
     *
     *   DONE — a device's burst ends only after it is truly idle
     *     (zero sector changes AND zero in-flight I/O) for
     *     IDLE_TICKS_BEFORE_DONE consecutive ticks, and the data is known
     *     to be flushed (or the kernel's expire window has passed).
     *     A notification fires naming only that specific device.
     */
    async _tick() {
        if (!this._indicator) return;                  // extension disabled mid-tick

        if (this._removableDevices.size === 0) {
            if (!this._doneSourceId)
                this._hideIndicator();
            return;
        }

        const cancellable = this._cancellable;
        const devices = [...this._removableDevices];

        // /proc/meminfo is only needed to decide whether a burst is over.
        const anyBurst = devices.some(([dev]) => this._devStats.get(dev)?.wasWriting);

        // Read all counters (and refresh open target files) in parallel
        const [allStats, systemPending] = await Promise.all([
            Promise.all(devices.map(async ([dev]) => {
                const [stats] = await Promise.all([
                    getBlockWriteStats(dev, cancellable),
                    this._refreshOpenFiles(dev),
                ]);
                return stats;
            })),
            anyBurst ? getSystemPendingBytes(cancellable) : null,
        ]);

        // Guard: extension may have been disabled during the async reads
        if (!this._indicator || this._cancellable !== cancellable) return;
        this._systemPending = systemPending;

        // Names of devices that just finished their burst this tick
        const justFinished = [];
        const now = nowMs();
        const maxIdleTicks = Math.ceil(this._maxIdleMs / (POLL_INTERVAL_SECONDS * 1000));

        // ── 1. Per-device delta analysis + state machine ──────────────────
        devices.forEach(([dev, devInfo], i) => {
            const stats = allStats[i];
            if (!stats) return;

            let st = this._devStats.get(dev);

            if (!st) {
                // First time seeing this device — store baseline
                this._devStats.set(dev, newDevStats(stats));
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
                // Phase 1: only large writes (or a large pending copy) can
                // start a burst
                const watch = this._watches.get(dev);
                const bigCopy = this._targetSize(dev) >= TARGET_TRIGGER_BYTES &&
                                watch && now - watch.lastEventAt < OPEN_FILE_ACTIVE_MS;
                if (isLargeWrite || bigCopy) {
                    st.wasWriting = true;
                    st.idleTicks  = 0;
                } else {
                    // Fork addition: forget target files whose writes never
                    // turned into a burst.
                    if (watch && now - watch.lastEventAt > TARGET_STALE_MS)
                        this._resetTargets(dev);
                }
            } else {
                // Phase 2: any activity, in-flight I/O or a copy still
                // producing data keeps it alive
                if (hasActivity || inFlight || this._hasActiveWriters(dev, now)) {
                    st.idleTicks = 0;
                } else {
                    st.idleTicks++;
                    const complete = this._looksComplete(dev, st, systemPending);
                    if ((st.idleTicks >= IDLE_TICKS_BEFORE_DONE && complete) ||
                        st.idleTicks >= maxIdleTicks) {
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

        // ── 3. Update the indicator ───────────────────────────────────────
        this._render(justFinished.length > 0);
    }

    // Fork addition: is this burst's data known to be on the device?
    // The flushed byte count must have reached the known target AND the
    // system must have (almost) nothing left to write anywhere: writes the
    // file watches can't see (existing subfolders, in-place overwrites)
    // would otherwise look finished too early.
    _looksComplete(dev, st, systemPending) {
        const target = this._targetSize(dev);
        if (target > 0 && st.totalBytesThisBurst + COMPLETE_SLACK_BYTES < target)
            return false;
        return systemPending !== null && systemPending <= SYSTEM_PENDING_SAFE_BYTES;
    }

    // Fork addition: build per-device view models from the current state.
    _activeDevices() {
        const active = [];
        for (const [dev, devInfo] of this._removableDevices) {
            const st = this._devStats.get(dev);
            if (!st?.wasWriting) continue;

            const target = this._targetSize(dev);
            let fraction = null;
            if (target > 0) {
                const f = Math.min(MAX_SHOWN_FRACTION, st.totalBytesThisBurst / target);
                // The total can grow while a multi-file copy is still filling
                // the page cache; don't let the shown percentage go backwards.
                st.shownFraction = Math.max(st.shownFraction, f);
                fraction = st.shownFraction;
            }

            let state;
            if (st.deltaBytesThisTick > 0)
                state = _('Writing to the drive…');
            else if (this._looksComplete(dev, st, this._systemPending))
                state = _('Finishing up…');
            else
                state = _('Data cached in memory, waiting for the kernel to write it');

            active.push({
                dev,
                label   : devInfo.label,
                written : st.totalBytesThisBurst,
                target,
                fraction,
                rate    : st.deltaBytesThisTick > 0 ? st.lastRateMBs : '0.0',
                state,
            });
        }
        return active;
    }

    _render(justFinished) {
        const active = this._activeDevices();

        if (active.length === 0) {
            if (justFinished)
                this._showDone();
            else if (!this._doneSourceId)
                this._hideIndicator();
            return;
        }

        this._cancelDone();
        const duration = BAR_ANIM_MS;

        // Panel: combined percentage of devices with a known target,
        // otherwise the combined flushed size.
        let barWritten = 0, barTotal = 0, written = 0;
        for (const a of active) {
            written += a.written;
            if (a.fraction !== null) {
                barWritten += a.fraction * a.target;
                barTotal   += a.target;
            }
        }

        if (barTotal > 0) {
            const fraction = barWritten / barTotal;
            if (!this._panelBar.actor.visible) {
                this._panelBar.setFraction(0, 0);
                this._panelBar.actor.show();
            }
            // Glide over one poll interval: steady progress looks
            // continuous and big jumps don't snap.
            this._panelBar.setFraction(fraction, duration);
            this._label.text = `${padFigures(Math.floor(fraction * 100), 3)}%`;
        } else {
            this._panelBar.actor.hide();
            this._label.text = `${padFigures(Math.round(written / (1024 * 1024)), 4)} MB`;
        }

        this._updateMenuRows(active, duration);
        this._flushItem.setSensitive(true);
        this._showIndicator();
    }

    // Briefly show a full bar and a check mark, then fade out.
    _showDone() {
        this._clearDoneTimer();
        this._removeMenuRows();
        this._flushItem.setSensitive(false);
        this._icon.icon_name = 'object-select-symbolic';
        this._panelBar.setDone(true);
        if (this._panelBar.actor.visible) {
            // Same pace as normal progress: speed ∝ remaining distance.
            this._panelBar.setFraction(1, BAR_ANIM_MS);
            this._label.text = '100%';
        } else {
            this._label.text = _('Done');
        }
        this._showIndicator();

        this._doneSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DONE_DISPLAY_MS, () => {
            this._doneSourceId = null;
            this._hideIndicator();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearDoneTimer() {
        if (this._doneSourceId) {
            GLib.source_remove(this._doneSourceId);
            this._doneSourceId = null;
        }
    }

    // Leave the done look (a new burst started while it was shown).
    _cancelDone() {
        this._clearDoneTimer();
        this._icon.icon_name = 'drive-removable-media-usb-symbolic';
        this._panelBar.setDone(false);
    }

    // ── Fork addition: details menu ────────────────────────────────────────

    _updateMenuRows(active, duration) {
        const seen = new Set();
        for (const a of active) {
            seen.add(a.dev);
            let row = this._menuRows.get(a.dev);
            if (!row) {
                row = this._createMenuRow();
                this._menuRows.set(a.dev, row);
                this._rowsSection.addMenuItem(row.item);
            }

            row.title.text = a.label;
            if (a.fraction !== null) {
                row.bar.actor.show();
                row.bar.setFraction(a.fraction, duration);
                row.detail.text = `${Math.floor(a.fraction * 100)}% · ` +
                    // Translators: "1.20 GB of 1.45 GB on the drive"
                    _('%s of %s on the drive').format(formatBytes(a.written), formatBytes(a.target)) +
                    ` · ${a.rate} MB/s`;
            } else {
                row.bar.actor.hide();
                row.detail.text = `${_('%s written to the drive').format(formatBytes(a.written))} · ${a.rate} MB/s`;
            }
            row.state.text = a.state;
        }

        for (const [dev, row] of [...this._menuRows]) {
            if (!seen.has(dev)) {
                row.bar.destroy();
                row.item.destroy();
                this._menuRows.delete(dev);
            }
        }
    }

    _createMenuRow() {
        const item = new PopupMenu.PopupBaseMenuItem({
            // reactive:false would add :insensitive and grey the row out.
            activate  : false,
            hover     : false,
            can_focus : false,
        });
        item.track_hover = false;
        const box  = makeVBox({ style_class: 'tup-row', x_expand: true });
        const title  = new St.Label({ style_class: 'tup-row-title' });
        const bar    = new ProgressBar(null, 'tup-bar-menu');
        const detail = new St.Label({ style_class: 'tup-row-detail' });
        const state  = new St.Label({ style_class: 'tup-row-state' });
        box.add_child(title);
        box.add_child(bar.actor);
        box.add_child(detail);
        box.add_child(state);
        item.add_child(box);
        return { item, title, bar, detail, state };
    }

    _removeMenuRows() {
        if (!this._menuRows) return;
        for (const row of this._menuRows.values()) {
            row.bar.destroy();
            row.item.destroy();
        }
        this._menuRows.clear();
    }

    // ── Notification ───────────────────────────────────────────────────────

    /**
     * Notify the user that a specific USB drive has finished syncing.
     * @param {string} devName    Device name, used for the per-device cooldown
     * @param {string} driveName  Human-readable label of the drive
     */
    _notifySyncComplete(devName, driveName) {
        const now = nowMs();
        if (now - (this._lastNotifyTime.get(devName) ?? -Infinity) < NOTIFY_COOLDOWN_MS) return;
        this._lastNotifyTime.set(devName, now);

        Main.notify(
            _('USB Sync Complete'),
            // Translators: %s is the drive name
            _('Write cache flushed — safe to eject %s.').format(driveName),
        );
    }
}

function logUnexpected(e) {
    if (!e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        console.error(e, '[TrueUsbProgress] Unexpected error');
}
