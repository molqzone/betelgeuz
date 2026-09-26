//! `cargo xtask` — codegen and packaging, keeping every generated artifact
//! derived from `betelgeuz-protocol` instead of hand-maintained.

fn main() {
    let task = std::env::args().nth(1).unwrap_or_default();
    match task.as_str() {
        // JSON Schema for the protocol, configuration keys, and descriptor.
        "gen-schema" => unimplemented(),
        // docs/ERRORS.md from the error catalog enum.
        "gen-errors" => unimplemented(),
        // TypeScript types for the VS Code adapter from the schema.
        "gen-ts" => unimplemented(),
        // Build core binaries and assemble the extension VSIX.
        "package" => unimplemented(),
        _ => {
            eprintln!("usage: cargo xtask <gen-schema|gen-errors|gen-ts|package>");
            std::process::exit(2);
        }
    }
}

fn unimplemented() -> ! {
    eprintln!("xtask: not implemented yet (Phase 0)");
    std::process::exit(1);
}
