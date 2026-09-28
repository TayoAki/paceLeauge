import Foundation
import SwiftUI

/** Shared by the watch app and its complication. */
enum Palette {
  static let lime = Color(red: 0xD5 / 255, green: 0xFF / 255, blue: 0x45 / 255)
  static let background = Color(red: 0x10 / 255, green: 0x13 / 255, blue: 0x15 / 255)
  static let surface = Color(red: 0x1B / 255, green: 0x20 / 255, blue: 0x23 / 255)
  static let text = Color(red: 0xF6 / 255, green: 0xF3 / 255, blue: 0xEA / 255)
  static let secondary = Color(red: 0xA9 / 255, green: 0xB0 / 255, blue: 0xAE / 255)
}

/** What the phone tells the watch (phone: src/features/watch/watch-link.ts). */
struct PhoneContext: Codable, Equatable {
  var units: String = "metric"
  var cues: Bool = true
  var activeDays: Int? = nil
  var goalDays: Int? = nil
  var leagueName: String? = nil
  var leagueRank: Int? = nil

  enum CodingKeys: String, CodingKey {
    case units, cues
    case activeDays = "active_days"
    case goalDays = "goal_days"
    case leagueName = "league_name"
    case leagueRank = "league_rank"
  }

  var metresPerUnit: Double { units == "imperial" ? 1609.344 : 1000 }
  var unitLabel: String { units == "imperial" ? "mi" : "km" }
  var unitWord: String { units == "imperial" ? "mile" : "kilometer" }
}

enum SharedStore {
  /** "group.<phone app bundle id>": strips ".watchkitapp" (and ".complication" in the complication). */
  static var appGroup: String {
    var id = Bundle.main.bundleIdentifier ?? "com.tayoaki.paceleague.watchkitapp"
    for suffix in [".complication", ".watchkitapp"] where id.hasSuffix(suffix) {
      id = String(id.dropLast(suffix.count))
    }
    return "group." + id
  }

  static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

  static func loadContext() -> PhoneContext {
    guard let data = defaults?.data(forKey: "phoneContext"), let context = try? JSONDecoder().decode(PhoneContext.self, from: data) else {
      return PhoneContext()
    }
    return context
  }

  static func saveContext(_ context: PhoneContext) {
    guard let data = try? JSONEncoder().encode(context) else { return }
    defaults?.set(data, forKey: "phoneContext")
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

/** Pace per unit as "5:12", or "--:--" before there is enough distance. */
func paceText(seconds: Double, metres: Double, metresPerUnit: Double) -> String {
  guard metres >= 50, seconds > 0 else { return "--:--" }
  let perUnit = Int((seconds / (metres / metresPerUnit)).rounded())
  guard perUnit < 100 * 60 else { return "--:--" }
  return String(format: "%d:%02d", perUnit / 60, perUnit % 60)
}
