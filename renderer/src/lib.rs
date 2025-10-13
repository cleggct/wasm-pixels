use std::collections::VecDeque;
use std::sync::Mutex;

wit_bindgen::generate!({
    path: "wit",
    world: "pixels-renderer",
});

use exports::cleggct::wasm_pixels::renderer::Guest;
use crate::cleggct::wasm_pixels::types as ty;

#[derive(Default)]
struct State {
    w: u32,
    h: u32,
    q: VecDeque<ty::Command>,
}
static STATE: Mutex<State> = Mutex::new(State { w:0, h:0, q:VecDeque::new() });

fn push(c: ty::Command) { STATE.lock().unwrap().q.push_back(c); }

struct Renderer;
impl Guest for Renderer {
    fn begin_frame(clear: Option<u32>) { push(ty::Command::BeginFrame(clear)); }
    fn end_frame() { push(ty::Command::EndFrame); }

    fn set_blend(mode: ty::BlendMode) { push(ty::Command::SetBlend(mode)); }
    fn set_camera(cam: ty::Camera) { push(ty::Command::SetCamera(cam)); }

    fn create_atlas(desc: ty::AtlasCreate) { push(ty::Command::CreateAtlas(desc)); }
    fn upload_atlas_chunk(ch: ty::AtlasRectChunk) { push(ty::Command::UploadAtlasChunk(ch)); }
    fn finalize_atlas(id: u16) { push(ty::Command::FinalizeAtlas(id)); }

    fn draw_sprite(s: ty::Sprite) { push(ty::Command::DrawSprite(s)); }
    fn draw_tiles(t: ty::Tiles) { push(ty::Command::DrawTiles(t)); }

    fn get_commands() -> Vec<ty::Command> {
        let mut st = STATE.lock().unwrap();
        let mut out = Vec::with_capacity(st.q.len());
        while let Some(c) = st.q.pop_front() { out.push(c); }
        out
    }

    fn init(width: u32, height: u32) {
        let mut st = STATE.lock().unwrap();
        st.w = width; st.h = height; st.q.clear();
    }
    fn resize(width: u32, height: u32) {
        let mut st = STATE.lock().unwrap();
        st.w = width; st.h = height;
    }
}
