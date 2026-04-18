#![allow(deprecated)]

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::{AnyClass, AnyObject};
#[cfg(target_os = "macos")]
use objc2::{msg_send, msg_send_id};

#[cfg(target_os = "macos")]
pub fn colorize_delay_badges() {
    unsafe {
        let cls = AnyClass::get(c"NSStatusBar").unwrap();
        let bar: Retained<AnyObject> = msg_send_id![cls, systemStatusBar];
        let items: Retained<AnyObject> = msg_send_id![&bar, statusItems];
        let count: usize = msg_send![&items, count];
        for i in 0..count {
            let item: Retained<AnyObject> = msg_send_id![&items, objectAtIndex: i];
            let menu: Option<Retained<AnyObject>> = msg_send_id![&item, menu];
            if let Some(menu) = menu {
                colorize_items(&menu);
            }
        }
    }
}

#[cfg(target_os = "macos")]
unsafe fn colorize_items(menu: &AnyObject) {
    let count: isize = msg_send![menu, numberOfItems];
    for i in 0..count {
        let item: Retained<AnyObject> = msg_send_id![menu, itemAtIndex: i];
        let submenu_opt: Option<Retained<AnyObject>> = msg_send_id![&item, submenu];
        if let Some(sub) = submenu_opt {
            colorize_items(&sub);
        }
        let title: Retained<AnyObject> = msg_send_id![&item, title];
        let utf8: *const i8 = msg_send![&title, UTF8String];
        if utf8.is_null() { continue; }
        let title_str = std::ffi::CStr::from_ptr(utf8).to_string_lossy().to_string();

        let markers = ["  🟢", "  🟡", "  🔴", "  ⚫"];
        let Some(pos) = markers.iter().find_map(|m| title_str.find(m)) else { continue };
        let node_part = &title_str[..pos];
        let badge_part = &title_str[pos..];
        let delay_ms: u64 = badge_part.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0);
        let is_timeout = badge_part.contains("timeout");
        let delay_text = if is_timeout { " timeout".into() } else if delay_ms > 0 { format!(" {}ms", delay_ms) } else { continue };

        let color_cls = AnyClass::get(c"NSColor").unwrap();
        let color: Retained<AnyObject> = if is_timeout || delay_ms == 0 {
            msg_send_id![color_cls, systemGrayColor]
        } else if delay_ms < 200 {
            msg_send_id![color_cls, systemGreenColor]
        } else if delay_ms < 500 {
            msg_send_id![color_cls, systemOrangeColor]
        } else {
            msg_send_id![color_cls, systemRedColor]
        };

        let font_cls = AnyClass::get(c"NSFont").unwrap();
        let normal_font: Retained<AnyObject> = msg_send_id![font_cls, menuFontOfSize: 13.0_f64];
        let small_font: Retained<AnyObject> = msg_send_id![font_cls, menuFontOfSize: 10.0_f64];
        let label_color: Retained<AnyObject> = msg_send_id![color_cls, labelColor];

        let node_nsstr = nsstr(node_part);
        let node_attrs = dict2(&nsstr("NSColor"), &label_color, &nsstr("NSFont"), &normal_font);
        let attr_cls = AnyClass::get(c"NSAttributedString").unwrap();
        let node_attr: Retained<AnyObject> = msg_send_id![msg_send_id![attr_cls, alloc], initWithString: &*node_nsstr, attributes: &*node_attrs];

        let delay_nsstr = nsstr(&delay_text);
        let delay_attrs = dict2(&nsstr("NSColor"), &color, &nsstr("NSFont"), &small_font);
        let delay_attr: Retained<AnyObject> = msg_send_id![msg_send_id![attr_cls, alloc], initWithString: &*delay_nsstr, attributes: &*delay_attrs];

        let mut_cls = AnyClass::get(c"NSMutableAttributedString").unwrap();
        let mutable: Retained<AnyObject> = msg_send_id![msg_send_id![mut_cls, alloc], initWithAttributedString: &*node_attr];
        let _: () = msg_send![&mutable, appendAttributedString: &*delay_attr];
        let _: () = msg_send![&item, setAttributedTitle: &*mutable];
    }
}

#[cfg(target_os = "macos")]
unsafe fn nsstr(s: &str) -> Retained<AnyObject> {
    let cls = AnyClass::get(c"NSString").unwrap();
    msg_send_id![cls, stringWithUTF8String: s.as_ptr()]
}

#[cfg(target_os = "macos")]
unsafe fn dict2(k1: &AnyObject, v1: &AnyObject, k2: &AnyObject, v2: &AnyObject) -> Retained<AnyObject> {
    let cls = AnyClass::get(c"NSDictionary").unwrap();
    let keys = [k1, k2];
    let vals = [v1, v2];
    msg_send_id![cls, dictionaryWithObjects: vals.as_ptr(), forKeys: keys.as_ptr(), count: 2usize]
}

#[cfg(not(target_os = "macos"))]
pub fn colorize_delay_badges() {}
