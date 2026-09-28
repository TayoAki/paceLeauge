import ActivityKit
import ExpoModulesCore

/**
 * The run on the lock screen and in the Dynamic Island (docs/ROADMAP.md 1.2). The app starts the
 * activity when a run starts, updates it every few seconds while the recorder runs in the
 * background, and ends it with the final numbers. While recording, the clock counts on its own
 * from `clockStart`, so it stays live between updates.
 *
 * `RunActivityAttributes` must match the copy in targets/widgets exactly: ActivityKit pairs the
 * app's activity with the widget's view by the type's name and its encoded fields.
 */
struct RunActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /** "recording", "paused", "auto_paused" or "finished". */
    var status: String
    var distance: String
    var distanceUnit: String
    var pace: String
    var paceUnit: String
    /** Active time at the moment of the update. */
    var activeSeconds: Double
    /** While recording: when the active clock would have read zero, so the view can count on. */
    var clockStart: Date?
  }

  var title: String
}

struct RunActivityState: Record {
  @Field
  var status: String = "recording"
  @Field
  var distance: String = "0.00"
  @Field
  var distanceUnit: String = "km"
  @Field
  var pace: String = "--:--"
  @Field
  var paceUnit: String = "/km"
  @Field
  var activeSeconds: Double = 0
  /** Epoch milliseconds; absent when the clock is stopped. */
  @Field
  var clockStartMs: Double? = nil

  var content: RunActivityAttributes.ContentState {
    RunActivityAttributes.ContentState(
      status: status,
      distance: distance,
      distanceUnit: distanceUnit,
      pace: pace,
      paceUnit: paceUnit,
      activeSeconds: activeSeconds,
      clockStart: clockStartMs.map { Date(timeIntervalSince1970: $0 / 1000) }
    )
  }
}

public final class RunActivityModule: Module {
  /** Updates stop arriving if the app is closed mid-run; after this the view says so. */
  private static let staleAfter: TimeInterval = 90

  public func definition() -> ModuleDefinition {
    Name("RunActivity")

    Function("isSupported") { () -> Bool in
      if #available(iOS 16.2, *) {
        return ActivityAuthorizationInfo().areActivitiesEnabled
      }
      return false
    }

    // Resolves with the activity id, or nil when Live Activities are off or unavailable.
    AsyncFunction("start") { (title: String, state: RunActivityState) async -> String? in
      guard #available(iOS 16.2, *), ActivityAuthorizationInfo().areActivitiesEnabled else {
        return nil
      }
      // One run at a time: anything left from an earlier run goes first.
      for activity in Activity<RunActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      let content = ActivityContent(state: state.content, staleDate: Date().addingTimeInterval(Self.staleAfter))
      do {
        let activity = try Activity.request(attributes: RunActivityAttributes(title: title), content: content, pushType: nil)
        return activity.id
      } catch {
        return nil
      }
    }

    AsyncFunction("update") { (state: RunActivityState) async in
      guard #available(iOS 16.2, *) else {
        return
      }
      let content = ActivityContent(state: state.content, staleDate: Date().addingTimeInterval(Self.staleAfter))
      for activity in Activity<RunActivityAttributes>.activities {
        await activity.update(content)
      }
    }

    // Ends every run activity. The final numbers stay on the lock screen for
    // `dismissAfterSeconds` (0 removes them at once, e.g. for a discarded run).
    AsyncFunction("end") { (state: RunActivityState, dismissAfterSeconds: Double) async in
      guard #available(iOS 16.2, *) else {
        return
      }
      let content = ActivityContent(state: state.content, staleDate: nil)
      let policy: ActivityUIDismissalPolicy =
        dismissAfterSeconds <= 0 ? .immediate : .after(Date().addingTimeInterval(dismissAfterSeconds))
      for activity in Activity<RunActivityAttributes>.activities {
        await activity.end(content, dismissalPolicy: policy)
      }
    }
  }
}
