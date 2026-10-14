#!/usr/bin/env ruby
require 'xcodeproj'
root = File.expand_path('..', __dir__)
path = File.join(root, 'ios/Prompix.xcodeproj')
project = Xcodeproj::Project.new(path)
project.root_object.development_region = "zh-Hans"
project.root_object.known_regions = ["zh-Hans", "zh-Hant", "en", "ja", "ko", "es", "pt-BR", "fr", "de", "Base"]
project.build_configurations.each do |config|
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '17.0'
  config.build_settings['SWIFT_VERSION'] = '6.0'
end
app = project.new_target(:application, 'Prompix', :ios, '17.0')
app.build_configurations.each do |config|
  config.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.p697.prompix',
    'PRODUCT_NAME' => 'Prompix', 'INFOPLIST_FILE' => 'Prompix/Info.plist',
    'SWIFT_VERSION' => '6.0', 'TARGETED_DEVICE_FAMILY' => '1,2',
    'CODE_SIGN_STYLE' => 'Automatic', 'MARKETING_VERSION' => '0.6.2',
    'CURRENT_PROJECT_VERSION' => '25', 'ASSETCATALOG_COMPILER_APPICON_NAME' => 'AppIcon',
    'ENABLE_USER_SCRIPT_SANDBOXING' => 'YES', 'SWIFT_STRICT_CONCURRENCY' => 'complete'
  })
end
group = project.main_group.new_group('Prompix', 'Prompix')
Dir.glob(File.join(root, 'ios/Prompix/**/*.swift')).sort.each do |file|
  relative = file.delete_prefix(File.join(root, 'ios/Prompix/'))
  app.source_build_phase.add_file_reference(group.new_file(relative))
end
resources = group.new_group('Resources', 'Resources')
Dir.glob(File.join(root, 'ios/Prompix/Resources/*')).sort.each do |file|
  ref = resources.new_file(File.basename(file))
  ref.last_known_file_type = 'folder' if File.directory?(file) && !file.end_with?('.xcassets')
  app.resources_build_phase.add_file_reference(ref)
end
['PrompixTests', 'PrompixUITests'].each do |name|
  type = name.end_with?('UITests') ? :ui_test_bundle : :unit_test_bundle
  target = project.new_target(type, name, :ios, '17.0')
  target.add_dependency(app)
  test_group = project.main_group.new_group(name, name)
  Dir.glob(File.join(root, "ios/#{name}/*.swift")).sort.each { |file| target.source_build_phase.add_file_reference(test_group.new_file(File.basename(file))) }
  resource_files = Dir.glob(File.join(root, "ios/#{name}/Resources/*")).sort
  unless resource_files.empty?
    test_resources = test_group.new_group('Resources', 'Resources')
    resource_files.each { |file| target.resources_build_phase.add_file_reference(test_resources.new_file(File.basename(file))) }
  end
  target.build_configurations.each do |config|
    config.build_settings.merge!({'PRODUCT_BUNDLE_IDENTIFIER' => "com.p697.#{name.downcase}", 'GENERATE_INFOPLIST_FILE' => 'YES', 'SWIFT_VERSION' => '6.0', 'CODE_SIGN_STYLE' => 'Automatic'})
    if type == :unit_test_bundle
      config.build_settings['TEST_HOST'] = '$(BUILT_PRODUCTS_DIR)/Prompix.app/Prompix'
      config.build_settings['BUNDLE_LOADER'] = '$(TEST_HOST)'
    else
      config.build_settings['TEST_TARGET_NAME'] = 'Prompix'
    end
  end
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.set_launch_target(app)
project.targets.select { |t| t.name.include?('Tests') }.each { |t| scheme.add_test_target(t) }
scheme.save_as(path, 'Prompix', true)
