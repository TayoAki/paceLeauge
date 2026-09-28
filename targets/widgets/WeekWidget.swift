import SwiftUI
import WidgetKit

/**
 * "This week" on the home and lock screens (docs/ROADMAP.md 1.11): active days against the weekly
 * goal, weekly XP and league rank. The app writes the numbers to the shared App Group after each
 * sync and asks WidgetKit to reload, so the widget follows a synced run within moments.
 */
struct WeekData: Codable {
  let activeDays: Int
  let goalDays: Int?
  let weeklyXp: Int
  let weekEndsAtMs: Double
  let leagueName: String?
  let rank: Int?
  let members: Int?
  let updatedAtMs: Double
}

struct WeekEntry: TimelineEntry {
  let date: Date
  let data: WeekData?

  /** After the week ends the numbers belong to last week; show a fresh week until the app syncs. */
  var current: WeekData? {
    guard let data, date.timeIntervalSince1970 * 1000 < data.weekEndsAtMs else { return nil }
    return data
  }
}

struct WeekProvider: TimelineProvider {
  static let key = "paceleague.week"

  func load() -> WeekData? {
    guard let raw = SharedStore.defaults?.string(forKey: Self.key), let json = raw.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(WeekData.self, from: json)
  }

  func placeholder(in context: Context) -> WeekEntry {
    WeekEntry(
      date: Date(),
      data: WeekData(activeDays: 2, goalDays: 3, weeklyXp: 257, weekEndsAtMs: Date().addingTimeInterval(86_400).timeIntervalSince1970 * 1000,
                     leagueName: "Friday Crew", rank: 2, members: 8, updatedAtMs: 0))
  }

  func getSnapshot(in context: Context, completion: @escaping (WeekEntry) -> Void) {
    completion(context.isPreview ? placeholder(in: context) : WeekEntry(date: Date(), data: load()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<WeekEntry>) -> Void) {
    let now = Date()
    let data = load()
    var entries = [WeekEntry(date: now, data: data)]
    // Flip to a fresh week exactly when this one ends.
    if let data {
      let ends = Date(timeIntervalSince1970: data.weekEndsAtMs / 1000)
      if ends > now { entries.append(WeekEntry(date: ends, data: data)) }
    }
    completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(60 * 60))))
  }
}

private func ordinal(_ n: Int) -> String {
  let suffix: String
  switch (n % 100, n % 10) {
  case (11...13, _): suffix = "th"
  case (_, 1): suffix = "st"
  case (_, 2): suffix = "nd"
  case (_, 3): suffix = "rd"
  default: suffix = "th"
  }
  return "\(n)\(suffix)"
}

private struct DaysLine: View {
  let data: WeekData?

  var body: some View {
    let days = data?.activeDays ?? 0
    if let goal = data?.goalDays {
      Text("\(days) of \(goal) days")
    } else {
      Text(days == 1 ? "1 active day" : "\(days) active days")
    }
  }
}

private struct GoalRing: View {
  let data: WeekData?

  var body: some View {
    let goal = max(1, data?.goalDays ?? 3)
    let days = data?.activeDays ?? 0
    ZStack {
      Circle().stroke(Palette.surface, lineWidth: 8)
      Circle()
        .trim(from: 0, to: min(1, CGFloat(days) / CGFloat(goal)))
        .stroke(Palette.lime, style: StrokeStyle(lineWidth: 8, lineCap: .round))
        .rotationEffect(.degrees(-90))
      Text("\(days)")
        .font(.system(size: 22, weight: .heavy, design: .rounded))
        .foregroundColor(Palette.text)
    }
  }
}

struct WeekWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: WeekEntry

  var body: some View {
    let data = entry.current
    switch family {
    case .accessoryCircular:
      let goal = Double(max(1, data?.goalDays ?? 3))
      Gauge(value: min(Double(data?.activeDays ?? 0), goal), in: 0...goal) {
        Text("days")
      } currentValueLabel: {
        Text("\(data?.activeDays ?? 0)")
      }
      .gaugeStyle(.accessoryCircularCapacity)
      .widgetBackground(.clear)
    case .accessoryRectangular:
      VStack(alignment: .leading, spacing: 2) {
        Text("PaceLeague").font(.headline)
        DaysLine(data: data)
        if let rank = data?.rank, let members = data?.members {
          Text("\(ordinal(rank)) of \(members) · \(data?.weeklyXp ?? 0) XP")
        } else {
          Text("\(data?.weeklyXp ?? 0) XP this week")
        }
      }
      .widgetBackground(.clear)
    case .accessoryInline:
      if let rank = data?.rank {
        Text("\(data?.activeDays ?? 0) days · \(ordinal(rank)) place")
      } else {
        Text("\(data?.activeDays ?? 0) active days this week")
      }
    case .systemMedium:
      HStack(spacing: 16) {
        GoalRing(data: data).frame(width: 84, height: 84)
        VStack(alignment: .leading, spacing: 4) {
          Text("THIS WEEK").font(.caption2.weight(.bold)).foregroundColor(Palette.lime)
          DaysLine(data: data).font(.headline).foregroundColor(Palette.text)
          Text("\(data?.weeklyXp ?? 0) XP").font(.subheadline).foregroundColor(Palette.secondary)
          if let league = data?.leagueName, let rank = data?.rank, let members = data?.members {
            Text("\(ordinal(rank)) of \(members) in \(league)")
              .font(.subheadline.weight(.semibold))
              .foregroundColor(Palette.text)
              .lineLimit(1)
          }
        }
        Spacer(minLength: 0)
      }
      .padding()
      .widgetBackground(Palette.background)
    default:
      VStack(alignment: .leading, spacing: 6) {
        Text("THIS WEEK").font(.caption2.weight(.bold)).foregroundColor(Palette.lime)
        GoalRing(data: data).frame(width: 58, height: 58)
        DaysLine(data: data).font(.subheadline.weight(.semibold)).foregroundColor(Palette.text)
        if let rank = data?.rank, let members = data?.members {
          Text("\(ordinal(rank)) of \(members)").font(.caption).foregroundColor(Palette.secondary)
        } else {
          Text("\(data?.weeklyXp ?? 0) XP").font(.caption).foregroundColor(Palette.secondary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding()
      .widgetBackground(Palette.background)
    }
  }
}

struct WeekWidget: Widget {
  static let kind = "PaceLeagueWeek"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: Self.kind, provider: WeekProvider()) { entry in
      WeekWidgetView(entry: entry)
        .widgetURL(URL(string: "paceleague://"))
    }
    .configurationDisplayName("This week")
    .description("Your active days, weekly XP and league place.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}
