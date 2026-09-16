mod jump;
mod server;
mod zoo;
#[cfg(target_os = "macos")]
mod app;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // The server alone, as bin/zoo-serve.js ran: what test/integration.js drives.
    if args.iter().any(|a| a == "--serve-only") {
        server::serve_only();
    }
    // Prints the request digest for {"tool_name", "tool_input"} on stdin, so a test
    // can check it against lib/permission.js.
    if args.iter().any(|a| a == "--digest") {
        let mut input = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut input).expect("stdin");
        let v: serde_json::Value = serde_json::from_str(&input).expect("JSON on stdin");
        println!("{}", zoo::request_digest(v.get("tool_name"), v.get("tool_input")));
        return;
    }
    #[cfg(target_os = "macos")]
    app::run();
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("zoo: the menu bar app is macOS-only; use --serve-only elsewhere");
        std::process::exit(1);
    }
}
