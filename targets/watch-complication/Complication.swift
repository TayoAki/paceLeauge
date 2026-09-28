import SwiftUI
import WidgetKit

/** What the watch app stored from the phone (targets/watch/Shared.swift). */
private struct PhoneContext: Codable {
  var activeDays: Int?
  var goalDays: Int?
  var leagueRank: Int?

  enum CodingKeys: String, CodingKey {
    case activeDays = "active_days"
    case goalDays = "goal_days"
    case leagueRank = "league_rank"
  }
}

private let lime = Color(red: 0xD5 / 255, green: 0xFF / 255, blue: 0x45 / 255)

private func loadContext() -> PhoneContext {
  // "<phone app bundle id>.watchkitapp.complication" → "group.<phone app bundle id>"
  var id = Bundle.main.bundleIdentifier ?? "com.tayoaki.paceleague.watchkitapp.complication"
  for suffix in [".complication", ".watchkitapp"] where id.hasSuffix(suffix) {
    id = String(id.dropLast(suffix.count))
  }
  guard let data = UserDefaults(suiteName: "group." + id)?.data(forKey: "phoneContext"),
        let context = try? JSONDecoder().decode(PhoneContext.self, from: data)
  else { return PhoneContext() }
  return context
}

struct LeagueEntry: TimelineEntry {
  let date: Date
  let rank: Int?
  let activeDays: Int?
  let goalDays: Int?
}

struct LeagueProvider: TimelineProvider {
  func placeholder(in context: Context) -> LeagueEntry {
    LeagueEntry(date: .now, rank: 4, activeDays: 2, goalDays: 3)
  }

  func getSnapshot(in context: Context, completion: @escaping (LeagueEntry) -> Void) {
    completion(entry())
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<LeagueEntry>) -> Void) {
    // The watch app reloads this whenever the phone sends something new.
    completion(Timeline(entries: [entry()], policy: .after(.now.addingTimeInterval(3_600))))
  }

  private func entry() -> LeagueEntry {
    let context = loadContext()
    return LeagueEntry(date: .now, rank: context.leagueRank, activeDays: context.activeDays, goalDays: context.goalDays)
  }
}

struct LeagueComplicationView: View {
  @Environment(\.widgetFamily) private var family
  let entry: LeagueEntry

  private var days: String {
    guard let active = entry.activeDays else { return "–" }
    return entry.goalDays.map { "\(active)/\($0)" } ?? "\(active)"
  }

  var body: some View {
    switch family {
    case .accessoryCircular:
      VStack(spacing: 0) {
        Text(entry.rank.map { "#\($0)" } ?? "–").font(.headline)
        Text(days).font(.caption2)
      }
      .accessibilityLabel(entry.rank.map { "Rank \($0) in your league, \(days) days this week" } ?? "\(days) days this week")
    case .accessoryInline:
      Text(entry.rank.map { "#\($0) · \(days) days" } ?? "\(days) days this week")
    case .accessoryCorner:
      Text(entry.rank.map { "#\($0)" } ?? days)
        .widgetLabel { Text("\(days) days") }
    default:
      VStack(alignment: .leading) {
        Text("PaceLeague").font(.headline).foregroundStyle(lime)
        Text(entry.rank.map { "#\($0) in your league" } ?? "Not in a league")
        Text("\(days) days this week").foregroundStyle(.secondary)
      }
    }
  }
}

@main
struct PaceLeagueComplication: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "PaceLeagueRank", provider: LeagueProvider()) { entry in
      LeagueComplicationView(entry: entry)
        .containerBackground(for: .widget) { Color.clear }
    }
    .configurationDisplayName("League and week")
    .description("Your league rank and this week’s active days.")
    .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
  }
}
