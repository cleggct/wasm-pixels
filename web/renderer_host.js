export function createRendererHost(canvas, {
    logicalWidth  = 800,
    logicalHeight = 450,
} = {}) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
    if (!gl) throw new Error('WebGL2 not available');

    // --- utils ---
    const rgba8 = (n) => [((n>>>24)&255)/255, ((n>>>16)&255)/255, ((n>>>8)&255)/255, (n&255)/255];
    const DPR = () => Math.max(1, Math.round(window.devicePixelRatio || 1));

    // --- shader pipeline (unit-quad) ---
    function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader error');
        return s;
    }
    function program(vs, fs) {
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link error');
        return p;
    }

    const VS = `#version 300 es
    precision highp float;
    layout(location=0) in vec2 a_pos;  // (0,0)..(1,1)
    layout(location=1) in vec2 a_uv;
    uniform vec2 u_screen;             // physical pixels
    uniform vec4 u_rect;               // x,y,w,h in logical pixels
    uniform mat3 u_cam;                // camera * hostScale (logical -> logical)
    out vec2 v_uv;
    void main(){
    vec2 p = u_rect.xy + a_pos * u_rect.zw; // logical pixel space
    vec3 w = u_cam * vec3(p, 1.0);          // still logical, but transformed
    vec2 ndc = ((w.xy / u_screen) * 2.0 - 1.0) * vec2(1.0, -1.0); // to NDC in physical pixels
    gl_Position = vec4(ndc, 0.0, 1.0);
    v_uv = a_uv;
    }`;

    const FS = `#version 300 es
    precision highp float;
    uniform sampler2D u_tex;
    uniform vec4 u_tint;
    in vec2 v_uv;
    out vec4 o_col;
    void main(){ o_col = texture(u_tex, v_uv) * u_tint; }`;

    const prog = program(VS, FS);
    const u_screen = gl.getUniformLocation(prog, 'u_screen');
    const u_rect   = gl.getUniformLocation(prog, 'u_rect');
    const u_cam    = gl.getUniformLocation(prog, 'u_cam');
    const u_tint   = gl.getUniformLocation(prog, 'u_tint');
    const u_tex    = gl.getUniformLocation(prog, 'u_tex');

    // geometry (two triangles forming a unit quad)
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const pos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([ 0,0, 1,0, 0,1, 1,0, 1,1, 0,1 ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const uv = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uv);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([ 0,0, 1,0, 0,1, 1,0, 1,1, 0,1 ]), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    // --- state managed by host ---
    let physW = canvas.width, physH = canvas.height;         // physical backing size in pixels
    let logicalW = logicalWidth, logicalH = logicalHeight;   // logical space the app uses

    // camera from WASM (built in JS from {origin_x, origin_y, scale, rotation})
    let camWasm = [1,0,0, 0,1,0, 0,0,1]; // row-major mat3

    // atlases
    const atlases = new Map(); // id -> { tex, width,height, cols,rows, tileW,tileH, uv, ready }

    // --- helpers: matrices & UVs ---
    function buildCamFromParams(o) {
        const c = Math.cos(o.rotation), s = Math.sin(o.rotation);
        const sx = o.scale, sy = o.scale;
        // translate by origin after rotation/scale: pack into affine mat3 (row-major)
        return [
            c*sx, -s*sy, o['origin-x'],
            s*sx,  c*sy, o['origin-y'],
            0,     0,    1
        ];
    }
    function hostScaleMat3() {
        const sx = physW / logicalW;
        const sy = physH / logicalH;
        return [ sx,0,0,  0,sy,0,  0,0,1 ];
    }
    function mul3x3(A,B) {
        return [
            A[0]*B[0]+A[1]*B[3]+A[2]*B[6], A[0]*B[1]+A[1]*B[4]+A[2]*B[7], A[0]*B[2]+A[1]*B[5]+A[2]*B[8],
            A[3]*B[0]+A[4]*B[3]+A[5]*B[6], A[3]*B[1]+A[4]*B[4]+A[5]*B[7], A[3]*B[2]+A[4]*B[5]+A[5]*B[8],
            A[6]*B[0]+A[7]*B[3]+A[8]*B[6], A[6]*B[1]+A[7]*B[4]+A[8]*B[7], A[6]*B[2]+A[7]*B[5]+A[8]*B[8],
        ];
    }
    function setTileUV(e, tileIndex, flip) {
        const cx = tileIndex % e.cols;
        const cy = Math.floor(tileIndex / e.cols);
        const u0 = (cx * e.tileW) * e.uv.u;
        const v0 = (cy * e.tileH) * e.uv.v;
        const u1 = ((cx+1) * e.tileW) * e.uv.u;
        const v1 = ((cy+1) * e.tileH) * e.uv.v;
        const fx = (flip & 1) !== 0, fy = (flip & 2) !== 0;
        const uu0 = fx ? u1 : u0, uu1 = fx ? u0 : u1;
        const vv0 = fy ? v1 : v0, vv1 = fy ? v0 : v1;

        gl.bindBuffer(gl.ARRAY_BUFFER, uv);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            uu0,vv0, uu1,vv0, uu0,vv1,
            uu1,vv0, uu1,vv1, uu0,vv1
        ]), gl.DYNAMIC_DRAW);
    }

    // --- WebGL command handlers ---
    function cmd_begin_frame(clear) {
        if (clear != null) {
            const [r,g,b,a] = rgba8(clear);
            gl.clearColor(r,g,b,a);
        }
        gl.clear(gl.COLOR_BUFFER_BIT);
    }
    function cmd_set_blend(mode) {
        if (mode === 'none') { gl.disable(gl.BLEND); return; }
        gl.enable(gl.BLEND);
        if (mode === 'alpha')     gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        else if (mode === 'additive') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        else if (mode === 'multiply') gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
    }
    function cmd_set_camera(cam) { camWasm = buildCamFromParams(cam); }

    function cmd_create_atlas(a) {
        let e = atlases.get(a.id);
        if (!e) { e = {}; atlases.set(a.id, e); }
        e.width = a.width; e.height = a.height;
        e.cols = a['cols']; e.rows = a['rows'];
        e.tileW = a['tile-w']; e.tileH = a['tile-h'];
        e.uv = { u: 1 / a.width, v: 1 / a.height };
        e.ready = false;
        e.tex = e.tex || gl.createTexture();

        gl.bindTexture(gl.TEXTURE_2D, e.tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, a.filter === 'linear' ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, a.filter === 'linear' ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, a.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, a.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, a.width, a.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    function cmd_upload_atlas_chunk(c) {
        const e = atlases.get(c.id); if (!e) return;
        gl.bindTexture(gl.TEXTURE_2D, e.tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, c.x, c.y, c.w, c.h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(c.data));
    }
    function cmd_finalize_atlas(id) { const e = atlases.get(id); if (e) e.ready = true; }

    function drawSprite(s) {
        const e = atlases.get(s['atlas-id']); if (!e || !e.ready) return;

        gl.useProgram(prog);
        gl.bindVertexArray(vao);

        // compose camera = hostScale * camWasm
        const cam = mul3x3(hostScaleMat3(), camWasm);

        gl.uniform2f(u_screen, physW, physH);
        gl.uniformMatrix3fv(u_cam, false, new Float32Array(cam));
        gl.uniform1i(u_tex, 0);

        const [r,g,b,a] = rgba8(s.tint);
        gl.uniform4f(u_tint, r,g,b,a);

        setTileUV(e, s['tile-index'], s.flip);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, e.tex);

        gl.uniform4f(u_rect, s.x, s.y, e.tileW, e.tileH); // logical pixels
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    function drawTiles(t) {
        const e = atlases.get(t['atlas-id']); if (!e || !e.ready) return;

        gl.useProgram(prog);
        gl.bindVertexArray(vao);

        const cam = mul3x3(hostScaleMat3(), camWasm);

        gl.uniform2f(u_screen, physW, physH);
        gl.uniformMatrix3fv(u_cam, false, new Float32Array(cam));
        gl.uniform1i(u_tex, 0);
        gl.uniform4f(u_tint, 1,1,1,1);

        const cw = t['cell-w'], ch = t['cell-h'];
        for (let gy = 0; gy < t['grid-h']; gy++) {
            for (let gx = 0; gx < t['grid-w']; gx++) {
                const idx = t.tiles[gy * t['grid-w'] + gx];
                setTileUV(e, idx, 0);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, e.tex);
                gl.uniform4f(u_rect, t.x + gx*cw, t.y + gy*ch, cw, ch);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            }
        }
    }

    // --- public API ---
    function exec(commands) {
        for (const c of commands) {
            if ('begin-frame' in c) {
                cmd_begin_frame(c['begin-frame']);
            } else if ('end-frame' in c) {
                // no-op; place for frame fences if needed
            } else if ('set-blend' in c) {
                cmd_set_blend(c['set-blend']);
            } else if ('set-camera' in c) {
                cmd_set_camera(c['set-camera']);
            } else if ('create-atlas' in c) {
                cmd_create_atlas(c['create-atlas']);
            } else if ('upload-atlas-chunk' in c) {
                cmd_upload_atlas_chunk(c['upload-atlas-chunk']);
            } else if ('finalize-atlas' in c) {
                cmd_finalize_atlas(c['finalize-atlas']);
            } else if ('draw-sprite' in c) {
                drawSprite(c['draw-sprite']);
            } else if ('draw-tiles' in c) {
                drawTiles(c['draw-tiles']);
            }
        }
    }

    function resizeToDisplaySize() {
        const r = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width  * DPR()));
        const h = Math.max(1, Math.round(r.height * DPR()));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w; canvas.height = h;
            physW = w; physH = h;
            gl.viewport(0, 0, physW, physH);
        }
    }

    function setLogicalSize(w, h) {
        logicalW = Math.max(1, w|0);
        logicalH = Math.max(1, h|0);
    }

    // initial viewport
    gl.viewport(0, 0, physW, physH);

    return {
        gl,
        exec,                 // run a list of renderer commands
        resizeToDisplaySize,  // call this on window resize
        setLogicalSize,       // optional: if the demo/renderer declares a different logical size
    };
}

