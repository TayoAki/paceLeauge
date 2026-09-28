Pod::Spec.new do |s|
  s.name           = 'WatchLink'
  s.version        = '1.0.0'
  s.summary        = 'The phone side of the PaceLeague Apple Watch app.'
  s.description    = 'WatchConnectivity (context to the watch, run files from it) and workout mirroring.'
  s.license        = { :type => 'Proprietary' }
  s.author         = 'PaceLeague'
  s.homepage       = 'https://github.com/TayoAki/paceLeauge'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/TayoAki/paceLeauge.git' }
  s.static_framework = true
  s.frameworks     = 'WatchConnectivity', 'HealthKit'

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
