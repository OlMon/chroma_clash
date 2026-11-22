"""
Chroma Clash hotkeys for OBS.

Adds hotkeys such as "Chroma Clash: Start a War" to OBS (Settings, Hotkeys).
Each one calls an action link of the running game.

Setup:
  1. OBS: Tools, Scripts, the Python Settings tab: point OBS to a Python 3 install
     (Windows: the version OBS names there; macOS/Linux: usually found by itself).
  2. Scripts tab: + and choose this file.
  3. In the control panel (Settings, Stream Deck and hotkeys), copy any action link
     and paste it into this script's "Action link" field. The address and the
     secret key are taken from it; which action the link names does not matter.
  4. OBS Settings, Hotkeys: give the "Chroma Clash: ..." entries the keys you want.
"""

import threading
import urllib.error
import urllib.parse
import urllib.request

import obspython as obs

ACTIONS = [
    ("war", "Start a War"),
    ("hero-clash", "Start a Hero Clash"),
    ("guild-clash", "Start a Guild Clash countdown"),
    ("free-for-all", "Start a free-for-all countdown"),
    ("pachinko", "Start a Pachinko countdown"),
    ("gods-wrath", "Start God's Wrath"),
    ("streamer-vs-chat", "Start Streamer vs Chat"),
    ("friendly-fight", "Start a friendly fight"),
    ("endless", "Endless mode on or off"),
    ("brawl", "Brawl on or off"),
    ("brawl-join", "Join the brawl as a fighter"),
    ("brawl-god", "Join the brawl as the god"),
    ("layer", "Chat plays: start or pause"),
    ("test-battle", "Start a test battle"),
    ("stop", "Stop whatever is running"),
]

link = ""
hotkeys = {}


def base_and_key():
    """The game's address and the secret key, from the pasted action link."""
    parsed = urllib.parse.urlparse(link.strip())
    key = urllib.parse.parse_qs(parsed.query).get("key", [""])[0]
    if not parsed.scheme or not parsed.netloc or not key:
        return None, None
    return f"{parsed.scheme}://{parsed.netloc}", key


def call(action):
    base, key = base_and_key()
    if not base:
        print("Chroma Clash: paste an action link from the control panel into the script's settings first.")
        return

    def run():
        url = f"{base}/api/action/{action}?key={urllib.parse.quote(key)}"
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                print(f"Chroma Clash: {response.read().decode('utf-8', 'replace')}")
        except urllib.error.HTTPError as error:
            print(f"Chroma Clash: {action} failed: {error.read().decode('utf-8', 'replace')}")
        except Exception as error:  # the game is not running, or another address
            print(f"Chroma Clash: {action} failed: {error}")

    # Never block OBS while waiting for the game.
    threading.Thread(target=run, daemon=True).start()


def script_description():
    return (
        "<b>Chroma Clash hotkeys</b><br>Paste any action link from the control panel "
        "(Settings, Stream Deck and hotkeys). Then set the keys in OBS Settings, Hotkeys."
    )


def script_properties():
    props = obs.obs_properties_create()
    obs.obs_properties_add_text(props, "link", "Action link", obs.OBS_TEXT_DEFAULT)
    return props


def script_update(settings):
    global link
    link = obs.obs_data_get_string(settings, "link")


def script_load(settings):
    script_update(settings)
    for action, description in ACTIONS:
        def pressed(is_pressed, action=action):
            if is_pressed:
                call(action)

        hotkey = obs.obs_hotkey_register_frontend(f"chroma_clash_{action}", f"Chroma Clash: {description}", pressed)
        saved = obs.obs_data_get_array(settings, f"hotkey_{action}")
        obs.obs_hotkey_load(hotkey, saved)
        obs.obs_data_array_release(saved)
        hotkeys[action] = hotkey


def script_save(settings):
    for action, hotkey in hotkeys.items():
        saved = obs.obs_hotkey_save(hotkey)
        obs.obs_data_set_array(settings, f"hotkey_{action}", saved)
        obs.obs_data_array_release(saved)
