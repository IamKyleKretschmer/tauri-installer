mod commands;
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
            system_checks::check_os,
            system_checks::check_cpu,
            system_checks::check_ram,
            system_checks::check_disk,
            system_checks::check_display,
            system_checks::check_sql_server,
            system_checks::check_iis,
            system_checks::check_vc_redist,
            system_checks::check_domain_joined,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
