//! The site the app shows, and how it introduces itself. Pure.

use url::Url;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// How the server tells the app from a browser (dashboard/lib/desktop.js: \bMintDesktop\/(\d+\.\d+\.\d+)):
/// a session length and the look, never what a session may do.
pub fn user_agent() -> String {
    format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0 MintDesktop/{}", VERSION)
}

/// The webview is locked to the site: same scheme, host and port.
pub fn same_site(u: &Url, o: &Url) -> bool {
    u.scheme() == o.scheme() && u.host_str() == o.host_str() && u.port_or_known_default() == o.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_webview_stays_on_the_site() {
        let o = Url::parse("https://os.mint-stack.com").unwrap();
        assert!(same_site(&Url::parse("https://os.mint-stack.com/mint-ai?shell=desktop").unwrap(), &o));
        assert!(same_site(&Url::parse("https://os.mint-stack.com:443/login").unwrap(), &o));
        assert!(!same_site(&Url::parse("http://os.mint-stack.com/").unwrap(), &o));
        assert!(!same_site(&Url::parse("https://os.mint-stack.com.evil.example/").unwrap(), &o));
        assert!(!same_site(&Url::parse("https://odoo19pg.mint-stack.com/").unwrap(), &o));
        assert!(!same_site(&Url::parse("https://os.mint-stack.com:8443/").unwrap(), &o));
    }

    #[test]
    fn the_user_agent_names_the_app() {
        let ua = user_agent();
        assert!(ua.ends_with(&format!("MintDesktop/{}", VERSION)));
        assert!(VERSION.split('.').count() == 3 && VERSION.split('.').all(|p| p.parse::<u32>().is_ok()));
    }
}
