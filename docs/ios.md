# iPhone (primary test device)

The iOS project lives in `ios/` (Capacitor 8, Swift Package Manager, iOS 15+). The web code, storage, reminders,
text-to-speech and backend calls are shared with Android; nothing iOS-specific is needed in `src/`.

## What already differs on iOS (handled)
- **Backend origin:** the iPhone app calls the server from `capacitor://localhost`; it is in the default
  `ALLOWED_ORIGINS` (tested).
- **Privacy manifest:** `ios/App/App/PrivacyInfo.xcprivacy` declares `UserDefaults` use (reason `CA92.1`) by the
  Preferences plugin. Apple rejects uploads without it, TestFlight included.
- **Notifications:** asked at first tap of «فعّل التذكيرات اليومية»; three repeating reminders (iOS allows 64 pending).
- **Russian voice:** built into iOS (no download needed, unlike many Android phones).
- **Safe areas / notch:** CSS uses `env(safe-area-inset-*)`.

## The hard constraint
Building an app that runs on a real iPhone requires **Xcode, which runs only on macOS**, and every build installed on
a device must be **signed with an Apple ID**. Windows cannot do either step.

## Routes to your iPhone

| Route | Needs | Cost | App lifetime on phone | Notes |
|---|---|---|---|---|
| A. Mac + free Apple ID | Any Mac with Xcode 16+ (yours, a friend's, a university lab), USB cable | Free | 7 days, then reinstall from Xcode | Fastest way to test today. No TestFlight, no sharing |
| B. Mac + Apple Developer Program | Route A + paid membership | $99/year | 90 days per TestFlight build; App Store when ready | Payment from Russia is reported as difficult in 2026; check before counting on it |
| C. Cloud Mac | Rented macOS machine (remote desktop) + Route A or B signing | Hourly/monthly rent | As A or B | For when no physical Mac is available |
| D. CI build only | GitHub repo; `.github/workflows/ios.yml` | Free on public repos | Not installable | Proves the iOS project compiles; useful on every change, not for using the app |

### Route A step by step (on the Mac)
```bash
git clone <your repo> && cd razgovor-dnya-app
npm ci
npm run ios:sync        # build web app + copy into ios/
npm run ios:open        # opens Xcode
```
In Xcode: select the **App** target → **Signing & Capabilities** → Team: your Apple ID (Personal Team) →
change Bundle Identifier to something unique, e.g. `com.xamad.razgovordnya`. Connect the iPhone, select it as the
run destination, press **Run ▶**. On the iPhone: Settings → General → VPN & Device Management → trust your Apple ID,
and turn on **Developer Mode** (Settings → Privacy & Security) when iOS asks.

### Until a Mac is available
The published Claude artifact of the app already runs on the iPhone through the Claude app (conversation, cards,
reviews, saved progress). Phone reminders for it were created in the iPhone's Reminders app.
