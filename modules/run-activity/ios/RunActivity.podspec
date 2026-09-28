Pod::Spec.new do |s|
  s.name           = 'RunActivity'
  s.version        = '1.0.0'
  s.summary        = 'The run on the lock screen and in the Dynamic Island.'
  s.description    = 'Starts, updates and ends the PaceLeague run Live Activity (ActivityKit).'
  s.license        = { :type => 'Proprietary' }
  s.author         = 'PaceLeague'
  s.homepage       = 'https://github.com/TayoAki/paceLeauge'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/TayoAki/paceLeauge.git' }
  s.static_framework = true
  s.frameworks     = 'ActivityKit'

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
