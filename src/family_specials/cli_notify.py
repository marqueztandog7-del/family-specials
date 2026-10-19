"""Phone notification commands.

  specials notify keys              make the notification keys (once): .env, GitHub secret, site/push.json
  specials notify add [code]        add a phone (the code from its Settings; no code = read the clipboard)
  specials notify devices           phones that get notifications
  specials notify remove <number>   stop sending to a phone
  specials notify test              send a test notification to every phone
  specials notify run [--dry-run]   send what's due (the Mac runs this after every update)
"""

from __future__ import annotations

import subprocess

from . import notify


def cmd_notify(args) -> int:
    if args.action == "keys":
        existed = notify.PUBLIC_KEY_FILE.exists()
        public = notify.create_keys(force=args.force)
        if existed and not args.force:
            print("Keys already exist (use --force to replace them: every phone would have to turn notifications on again).")
        else:
            print("Made the notification keys: private key in .env and the VAPID_PRIVATE_KEY secret on GitHub,"
                  " public key in site/push.json (commit it).")
        print(f"Public key: {public}")
        return 0

    if args.action == "add":
        code = args.value or subprocess.run(["pbpaste"], capture_output=True, text=True).stdout
        try:
            device = notify.decode_code(code)
        except ValueError as e:
            print(e)
            return 1
        devices = [d for d in notify.load_devices() if d["endpoint"] != device["endpoint"]]
        devices.append(device)
        notify.save_devices(devices)
        print(f"Added '{device['name']}' ({notify.service_name(device['endpoint'])}). "
              f"{len(devices)} phone(s) get notifications. Send a test with: uv run specials notify test")
        return 0

    if args.action == "devices":
        devices = notify.load_devices()
        for n, d in enumerate(devices, 1):
            print(f"{n}. {d['name']:24} {notify.service_name(d['endpoint']):8} added {d.get('added', '')[:10]}")
        print(f"{len(devices)} phone(s)" if devices else "No phones yet. Turn on notifications in the app's Settings.")
        return 0

    if args.action == "remove":
        devices = notify.load_devices()
        try:
            gone = devices.pop(int(args.value) - 1)
        except (TypeError, ValueError, IndexError):
            print("Give the phone's number from: uv run specials notify devices")
            return 1
        notify.save_devices(devices)
        print(f"Removed '{gone['name']}'. {len(devices)} phone(s) left.")
        return 0

    if args.action == "test":
        devices = notify.load_devices()
        if not devices:
            print("No phones yet. Turn on notifications in the app's Settings, then: uv run specials notify add")
            return 1
        r = notify.send(devices, {"title": "Test notification", "body": "Notifications work on this phone.",
                                  "url": "#/home", "tag": "test"})
        for d in r["ok"]:
            print(f"Sent to {d['name']}")
        for d in r["failed"]:
            print(f"Couldn't reach {d['name']}: {d['error']}")
        for d in r["gone"]:
            print(f"{d['name']} has turned notifications off")
        if r["gone"] and not notify.os.environ.get("PUSH_SUBSCRIPTIONS"):
            gone = {d["endpoint"] for d in r["gone"]}
            notify.save_devices([d for d in devices if d["endpoint"] not in gone])
            print("Removed the phones that turned notifications off.")
        return 0 if r["ok"] else 1

    return notify.run(dry_run=args.dry_run)


def register(sub) -> None:
    p = sub.add_parser("notify", help="phone notifications: keys, add/remove phones, test, run")
    p.add_argument("action", choices=["keys", "add", "devices", "remove", "test", "run"])
    p.add_argument("value", nargs="?", help="add: the phone's code; remove: the phone's number")
    p.add_argument("--force", action="store_true", help="keys: replace existing keys")
    p.add_argument("--dry-run", action="store_true", help="run: show what would be sent")
    p.set_defaults(func=cmd_notify)
