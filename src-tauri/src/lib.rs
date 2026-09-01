mod blueprint;
mod commands;
mod system_actions;
mod system_checks;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::hello,
            commands::get_product_info,
            commands::detect_dotnet,
            commands::detect_k2_installed,
            commands::get_installed_k2_version,
            commands::run_dotnet,
            commands::test_sql_connection,
            commands::check_ad_objects,
            system_checks::check_os,
            system_checks::check_cpu,
            system_checks::check_ram,
            system_checks::check_disk,
            system_checks::check_display,
            system_checks::check_sql_server,
            system_checks::check_iis,
            system_checks::check_vc_redist,
            system_checks::check_domain_joined,
            system_checks::check_tls12,
            system_checks::check_tls_legacy,
            system_checks::check_ipv4,
            system_checks::check_port,
            system_checks::list_certificates,
            system_checks::get_machine_fqdn,
            system_actions::configure_iis_site,
            system_actions::copy_k2_files,
            system_actions::scaffold_k2_placeholder_pages,
            system_actions::disable_legacy_tls,
            system_actions::grant_service_logon_right,
            system_actions::write_install_log,
            blueprint::get_launch_args,
            blueprint::write_text_file,
            blueprint::read_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
