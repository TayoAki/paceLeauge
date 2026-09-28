import ActivityKit
import SwiftUI
import WidgetKit

/**
 * The run on the lock screen and in the Dynamic Island (docs/ROADMAP.md 1.2). Distance and pace
 * come from the app's updates every few seconds; while recording, the clock counts on its own.
 */
struct RunLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: RunActivityAttributes.self) { context in
      RunLockScreenView(state: context.state, stale: context.isStale)
        .activityBackgroundTint(Palette.background)
        .activitySystemActionForegroundColor(Palette.lime)
        .widgetURL(URL(string: "paceleague://run/active"))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          VStack(alignment: .leading, spacing: 0) {
            Text(context.state.distance)
              .font(.system(size: 30, weight: .heavy, design: .rounded))
              .monospacedDigit()
              .foregroundColor(Palette.text)
            Text(context.state.distanceUnit.uppercased())
              .font(.caption2.weight(.semibold))
              .foregroundColor(Palette.secondary)
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          VStack(alignment: .trailing, spacing: 0) {
            RunClock(state: context.state, stale: context.isStale)
              .font(.system(size: 24, weight: .bold, design: .rounded))
              .monospacedDigit()
              .foregroundColor(Palette.text)
            Text("TIME")
              .font(.caption2.weight(.semibold))
              .foregroundColor(Palette.secondary)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack {
            Text("\(context.state.pace) \(context.state.paceUnit)")
              .font(.headline)
              .monospacedDigit()
              .foregroundColor(Palette.text)
            Spacer()
            StatusLabel(state: context.state, stale: context.isStale)
          }
        }
      } compactLeading: {
        Image(systemName: context.state.status == "recording" ? "figure.run" : "pause.fill")
          .foregroundColor(Palette.lime)
      } compactTrailing: {
        Text("\(context.state.distance) \(context.state.distanceUnit)")
          .font(.caption.weight(.semibold))
          .monospacedDigit()
          .foregroundColor(Palette.text)
      } minimal: {
        Image(systemName: "figure.run")
          .foregroundColor(Palette.lime)
      }
      .widgetURL(URL(string: "paceleague://run/active"))
      .keylineTint(Palette.lime)
    }
  }
}

struct RunClock: View {
  let state: RunActivityAttributes.ContentState
  let stale: Bool

  var body: some View {
    if state.status == "recording", !stale, let start = state.clockStart {
      Text(timerInterval: start...Date.distantFuture, countsDown: false)
        .multilineTextAlignment(.trailing)
    } else {
      Text(clockText(state.activeSeconds))
    }
  }
}

struct StatusLabel: View {
  let state: RunActivityAttributes.ContentState
  let stale: Bool

  var body: some View {
    let (text, color): (String, Color) = {
      if stale && state.status == "recording" { return ("Open PaceLeague", Palette.secondary) }
      switch state.status {
      case "paused": return ("Paused", Palette.secondary)
      case "auto_paused": return ("Auto-paused", Palette.secondary)
      case "finished": return ("Saved", Palette.lime)
      default: return ("Recording", Palette.lime)
      }
    }()
    Text(text)
      .font(.caption.weight(.semibold))
      .foregroundColor(color)
  }
}

struct RunLockScreenView: View {
  let state: RunActivityAttributes.ContentState
  let stale: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Label("PaceLeague", systemImage: "figure.run")
          .font(.caption.weight(.semibold))
          .foregroundColor(Palette.lime)
        Spacer()
        StatusLabel(state: state, stale: stale)
      }
      HStack(alignment: .lastTextBaseline, spacing: 16) {
        Metric(value: Text(state.distance), label: state.distanceUnit.uppercased(), size: 34)
        Spacer(minLength: 0)
        Metric(value: RunClockText(state: state, stale: stale), label: "TIME", size: 24)
        Metric(value: Text(state.pace), label: state.paceUnit.uppercased(), size: 24)
      }
    }
    .padding(16)
  }
}

/** The clock as a Text, so it can be styled like the other numbers. */
private func RunClockText(state: RunActivityAttributes.ContentState, stale: Bool) -> Text {
  if state.status == "recording", !stale, let start = state.clockStart {
    return Text(timerInterval: start...Date.distantFuture, countsDown: false)
  }
  return Text(clockText(state.activeSeconds))
}

private struct Metric: View {
  let value: Text
  let label: String
  let size: CGFloat

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      value
        .font(.system(size: size, weight: .heavy, design: .rounded))
        .monospacedDigit()
        .foregroundColor(Palette.text)
        .lineLimit(1)
        .minimumScaleFactor(0.6)
      Text(label)
        .font(.caption2.weight(.semibold))
        .foregroundColor(Palette.secondary)
    }
  }
}
