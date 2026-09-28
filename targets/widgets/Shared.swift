import ActivityKit
import SwiftUI
import WidgetKit

/**
 * Must match `RunActivityAttributes` in modules/run-activity exactly: ActivityKit pairs the app's
 * activity with these views by the type's name and its encoded fields.
 */
struct RunActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /** "recording", "paused", "auto_paused" or "finished". */
    var status: String
    var distance: String
    var distanceUnit: String
    var pace: String
    var paceUnit: String
    var activeSeconds: Double
    var clockStart: Date?
  }

  var title: String
}

enum Palette {
  static let lime = Color(red: 0xD5 / 255, green: 0xFF / 255, blue: 0x45 / 255)
  static let background = Color(red: 0x10 / 255, green: 0x13 / 255, blue: 0x15 / 255)
  static let surface = Color(red: 0x1B / 255, green: 0x20 / 255, blue: 0x23 / 255)
  static let text = Color(red: 0xF6 / 255, green: 0xF3 / 255, blue: 0xEA / 255)
  static let secondary = Color(red: 0xA9 / 255, green: 0xB0 / 255, blue: 0xAE / 255)
}

enum SharedStore {
  /** "group.<app bundle id>"; this extension's bundle id is "<app bundle id>.widgets". */
  static var appGroup: String {
    let id = Bundle.main.bundleIdentifier ?? "com.tayoaki.paceleague.widgets"
    return "group." + id.split(separator: ".").dropLast().joined(separator: ".")
  }

  static var defaults: UserDefaults? {
    UserDefaults(suiteName: appGroup)
  }
}

/** "1:02:03" or "31:28". */
func clockText(_ seconds: Double) -> String {
  let total = max(0, Int(seconds.rounded(.down)))
  let h = total / 3600
  let m = (total % 3600) / 60
  let s = total % 60
  return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
}

extension View {
  /** iOS 17 widgets draw their own background; earlier versions use a plain one. */
  @ViewBuilder
  func widgetBackground(_ color: Color) -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      containerBackground(for: .widget) { color }
    } else {
      background(color)
    }
  }
}
