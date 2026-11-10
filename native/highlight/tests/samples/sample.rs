use std::collections::HashMap;
#[derive(Debug, Clone)]
pub struct Cache<'a> { map: HashMap<&'a str, u32> }
impl<'a> Cache<'a> {
    pub fn get(&self, k: &str) -> Option<&u32> { self.map.get(k) }
}
fn main() { let mut c = Cache { map: HashMap::new() }; println!("{:?} {}", c.get("x"), 1_000u64); }
