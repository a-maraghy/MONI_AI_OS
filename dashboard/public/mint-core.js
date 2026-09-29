"use strict";
/*
 * The MINT AI core: one canvas, three concepts, six states.
 *
 *   A  Dotted sphere  a sphere of dots that ripples, knots, rings and flows
 *   B  Siri fluid     a glassy fluid orb that melts into voice waves
 *   C  Hybrid         the dotted sphere with the brand spark at its heart
 *                     (the spark is a DOM element the page places; see #cc-spark)
 *
 * States: idle · listening (the real microphone level) · thinking (a turn is
 * running) · delegating (a stream of dots flies to the session that got the
 * work) · speaking (the real output level of the voice) · needs (something is
 * waiting for you). Every state is a set of weights that JS eases toward; the
 * GPU does all the per-dot work, so a frame costs a handful of uniforms.
 *
 * WebGL first; a Canvas-2D fallback draws a lighter version of each concept
 * when WebGL is missing (or a shader will not compile). DPR is capped at 2;
 * the loop stops while the tab is hidden; with prefers-reduced-motion one
 * still frame is drawn per change. Concept B, whose cost is per pixel, drops
 * to half resolution if frames come slower than ~45 fps.
 *
 * Ported from the approved mockup (scratchpad/mint-simple/src/core.js); the
 * shaders are the mockup's, unchanged.
 *
 * Exposes window.MintCore(canvas, opts) -> an instance. Used by cc-map.js on
 * the Command Center and by mint-settings.js for the Appearance previews.
 */
(function () {
  if (typeof window === "undefined") return;

  /* ---------------------------------------------------------- shaders (from the mockup) */
  var NOISE = `
  vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
  float snoise(vec3 v){
    const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
    vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
    vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
    vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
    i=mod289(i);
    vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
    float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
    vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
    vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
    vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
    vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
    vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
    vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
    vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
    p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
    vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
    return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
  }`;

  /* ---------------- points: A and C ---------------- */
  var PT_VS = `
  precision highp float;
  attribute vec3 a_dir; attribute vec2 a_rnd;
  uniform vec2 u_res; uniform vec2 u_c; uniform float u_R; uniform float u_dpr;
  uniform float u_t; uniform float u_rot; uniform float u_amp; uniform float u_light; uniform float u_mode;
  uniform float u_rip; uniform float u_knot; uniform float u_gal; uniform float u_line;
  uniform float u_wave; uniform float u_pulse; uniform float u_need; uniform float u_deleg; uniform float u_think;
  uniform vec2 u_dest; uniform float u_size;
  varying vec4 v_col;
  ${NOISE}
  const float PI=3.14159265;
  vec3 rotY(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);}
  vec3 rotX(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(p.x,c*p.y-s*p.z,s*p.y+c*p.z);}
  vec3 rotZ(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(c*p.x-s*p.y,s*p.x+c*p.y,p.z);}
  void main(){
    vec3 d=a_dir; float t=u_t;
    float lat=acos(clamp(d.y,-1.0,1.0));
    float lon=atan(d.z,d.x);
    float n=snoise(d*1.55+vec3(0.0,t*0.16,t*0.11));
    float heart=pow(max(sin(t*2.2),0.0),6.0)+0.6*pow(max(sin(t*2.2-0.55),0.0),8.0);

    /* sphere: breathing + slow noise, ripples from the front (listening), pulse (speaking) */
    float r=1.0+0.022*sin(t*1.05)+n*(0.035+0.05*u_think);
    vec3 dv=rotY(d,u_rot); float ang=acos(clamp(dv.z,-1.0,1.0));
    r+=u_rip*(0.03+0.24*u_amp)*sin(ang*8.0-t*7.0)*exp(-ang*0.6);
    r+=u_pulse*(0.03+u_amp*0.26)*(0.5+0.5*sin(ang*3.0-t*10.0));
    r*=1.0-0.12*u_deleg;
    vec3 sp=d*r;
    sp=rotY(sp,u_rot);
    sp.z+=u_rip*(0.18+0.34*u_amp)*max(dv.z,0.0);

    /* needs-you: dots gather into latitude rings, with a heartbeat */
    float k=12.0; float latQ=(floor(lat/PI*k)+0.5)/k*PI;
    vec3 ring=vec3(sin(latQ)*cos(lon+u_rot*0.6),cos(latQ),sin(latQ)*sin(lon+u_rot*0.6))*(1.0+0.05*heart);
    sp=mix(sp,ring,u_need*0.92);

    /* A thinking: a (2,3) torus knot that flows */
    float s=lon+PI+t*0.32; float tub=lat*2.0+t*1.6;
    vec3 kc=vec3((2.0+cos(3.0*s))*cos(2.0*s),(2.0+cos(3.0*s))*sin(2.0*s),sin(3.0*s)*1.3)*0.34;
    vec3 kn=normalize(vec3(kc.xy,0.0)+1e-4);
    vec3 kp=kc+0.15*(cos(tub)*kn+sin(tub)*vec3(0.0,0.0,1.0))*(0.85+0.3*n);
    kp=rotX(rotZ(kp,t*0.22),0.35);
    sp=mix(sp,kp,u_knot);

    /* C thinking: a two-armed spiral disc around the spark */
    float rr=pow(a_rnd.y,0.7)*1.15+0.08;
    float arm=floor(a_rnd.x*2.0)*PI;
    float ga=arm+rr*3.4+lat*0.35-t*(0.55/(rr+0.35));
    vec3 gp=vec3(cos(ga)*rr,(a_rnd.x-0.5)*0.05*(1.3-rr)+n*0.03,sin(ga)*rr);
    gp=rotX(gp,1.05); gp=rotZ(gp,-0.18);
    sp=mix(sp,gp,u_gal);

    /* C listening: one oscilloscope line that follows the mic */
    float lx=(lon/PI);
    float env=pow(max(1.0-lx*lx,0.0),1.6);
    vec3 lp=vec3(lx*1.45,env*(0.14+u_amp)*(0.34*sin(lx*11.0+t*8.0)+0.22*sin(lx*23.0-t*11.0))+(a_rnd.y-0.5)*0.03*env+n*0.02,(a_rnd.x-0.5)*0.05);
    sp=mix(sp,lp,u_line);

    /* C speaking: the sphere melts into Siri waves made of dots */
    float rib=floor(a_rnd.x*4.0);
    float fr=2.2+rib*0.9; float ph=rib*1.7; float sp_=2.4+rib*0.7;
    float amp_=(0.26+0.5*u_amp)*(1.0-rib*0.16);
    float wy=env*amp_*sin(lx*fr*PI*0.5+t*sp_+ph)*(0.8+0.2*sin(t*1.3+rib));
    vec3 wp=vec3(lx*1.5,wy*(a_rnd.y*2.0-1.0>0.0?1.0:-1.0)*mix(0.25,1.0,a_rnd.y)+n*0.012,(rib-1.5)*0.07);
    sp=mix(sp,wp,u_wave);

    /* view */
    vec3 p=rotX(sp,0.30*(1.0-u_knot)*(1.0-u_gal)*(1.0-u_line)*(1.0-u_wave));
    float cam=3.3; float persp=cam/(cam-p.z);
    vec2 scr=u_c+vec2(p.x,-p.y)*u_R*persp;

    /* delegating: a stream of dots peels off toward the destination */
    float sel=step(a_rnd.x,0.24);
    float f=fract(t*0.42+a_rnd.y*3.0);
    vec2 A=scr; vec2 B=u_dest; vec2 mid=(A+B)*0.5; vec2 dir=B-A; vec2 nrm=normalize(vec2(-dir.y,dir.x)+1e-4);
    vec2 ctrl=mid+nrm*length(dir)*0.28*(a_rnd.y-0.3);
    float fe=f*f*(3.0-2.0*f);
    vec2 bz=mix(mix(A,ctrl,fe),mix(ctrl,B,fe),fe)+nrm*sin(f*PI*3.0+a_rnd.y*20.0)*6.0*u_dpr*(1.0-f);
    float ds=u_deleg*sel;
    scr=mix(scr,bz,ds);

    gl_Position=vec4((scr/u_res)*2.0-1.0,0.0,1.0); gl_Position.y=-gl_Position.y;
    float depth=clamp((p.z+1.25)/2.5,0.0,1.0);
    float flat_=max(max(u_line,u_wave),u_gal*0.6);
    depth=mix(depth,0.75,flat_);
    float spark=step(0.975,a_rnd.y);
    gl_PointSize=(1.25+2.6*depth*depth)*u_dpr*u_size*persp*mix(1.0,1.2,ds)*(1.0+0.7*spark)*mix(1.0,1.15,u_light);

    /* colour: mint -> cyan -> violet across the body, with a warm tint for needs-you */
    float g=clamp(0.5+0.62*(p.x*0.6+p.y*0.6)+0.2*n+0.3*u_think-0.1*u_line,0.0,1.0);
    g=mix(g,a_rnd.x*0.25+rib*0.2,u_wave*0.7);
    vec3 mint=mix(vec3(0.0,0.90,0.647),vec3(0.0,0.56,0.40),u_light);
    vec3 cyan=mix(vec3(0.25,0.78,0.77),vec3(0.03,0.50,0.56),u_light);
    vec3 vio=mix(vec3(0.60,0.30,1.0),vec3(0.45,0.13,0.77),u_light);
    vec3 col=g<0.5?mix(mint,cyan,g*2.0):mix(cyan,vio,(g-0.5)*2.0);
    float warm=u_need*step(0.5,fract(latQ/PI*k*0.5))*(0.55+0.45*heart);
    col=mix(col,mix(vec3(0.98,0.74,0.30),vec3(0.80,0.45,0.0),u_light),min(1.0,warm*1.1));
    col=mix(col,mix(vec3(0.75,1.0,0.92),vec3(0.0,0.45,0.35),u_light),ds*(1.0-f)*0.5);
    float a=mix(mix(0.07,0.16,u_light),1.0,pow(depth,1.4));
    a*=0.62+0.55*(n*0.5+0.5);
    a=min(1.0,a*(1.0+0.8*spark));
    a*=mix(1.0,1.0-smoothstep(0.82,1.0,f)*0.9,ds);
    float lift=u_amp*(u_rip*max(dv.z,0.0)+u_pulse*0.8);
    col=mix(col,mix(vec3(0.85,1.0,0.95),col*0.8,u_light),clamp(lift*0.45,0.0,0.6));
    col*=mix(1.18,1.0,u_light);
    a=min(1.0,a*(1.0+0.6*lift));
    v_col=vec4(col,a);
  }`;
  var PT_FS = `
  precision highp float;
  varying vec4 v_col; uniform float u_light;
  void main(){
    float d=length(gl_PointCoord-0.5);
    float a=smoothstep(0.5,0.18,d)*v_col.a;
    if(u_light>0.5){ gl_FragColor=vec4(v_col.rgb*a,a); }
    else { gl_FragColor=vec4(v_col.rgb*a*0.95,a); }
  }`;

  /* ---------------- fluid: B ---------------- */
  var FL_VS = `attribute vec2 a_p; void main(){gl_Position=vec4(a_p,0.0,1.0);}`;
  var FL_FS = `
  precision highp float;
  uniform vec2 u_res; uniform vec2 u_c; uniform float u_R; uniform float u_t; uniform float u_amp; uniform float u_light;
  uniform float u_bw; uniform float u_bl; uniform float u_bthink; uniform float u_bdel; uniform float u_bneed; uniform vec2 u_ddir; uniform float u_dpr;
  ${NOISE}
  const float PI=3.14159265;
  vec3 MINT(){return mix(vec3(0.0,0.90,0.647),vec3(0.0,0.72,0.52),u_light);}
  vec3 TEAL(){return mix(vec3(0.04,0.32,0.30),vec3(0.05,0.55,0.50),u_light);}
  vec3 VIO(){return mix(vec3(0.54,0.17,0.89),vec3(0.50,0.20,0.86),u_light);}
  vec3 CYAN(){return mix(vec3(0.24,0.86,0.92),vec3(0.10,0.66,0.80),u_light);}
  vec3 AMB(){return vec3(0.96,0.70,0.27);}
  float blob(vec2 p,vec2 c,float s){vec2 d=p-c;return exp(-dot(d,d)/(s*s));}
  void main(){
    vec2 fc=vec2(gl_FragCoord.x,u_res.y-gl_FragCoord.y);
    vec2 p=(fc-u_c)/u_R; p.y=-p.y;
    float px=1.0/u_R;
    float t=u_t;
    float heart=pow(max(sin(t*2.2),0.0),6.0)+0.6*pow(max(sin(t*2.2-0.55),0.0),8.0);
    float spin=t*(0.35+1.4*u_bthink);

    /* ---- orb ---- */
    float wave=clamp(u_bw+u_bl*0.75,0.0,1.0);
    float Rb=0.80*(1.0+0.025*sin(t*1.1)+0.03*heart*u_bneed)*(1.0-0.6*wave)*(1.0-0.1*u_bdel);
    /* delegating: stretch toward the destination */
    float along=dot(p,u_ddir); vec2 perp=p-along*u_ddir;
    float stretch=u_bdel*(0.35+0.12*sin(t*3.0));
    vec2 q=p; if(along>0.0){ q=perp+u_ddir*along/(1.0+stretch*1.6); }
    float r=length(q); float an=atan(q.y,q.x);
    float wob=(0.018+0.05*u_bthink+0.06*u_amp*u_bw)*snoise(vec3(cos(an)*1.3,sin(an)*1.3,t*(0.45+1.1*u_bthink)));
    float R=Rb+wob*Rb;
    float inside=smoothstep(R+px*1.2,R-px*1.2,r);
    vec2 ip=q/max(R,0.05);
    vec3 col=TEAL();
    float cs=cos(spin),sn=sin(spin); mat2 rot=mat2(cs,-sn,sn,cs);
    vec2 rp=rot*ip;
    col=mix(col,MINT(),blob(rp,vec2(-0.45,0.35+0.1*sin(t*0.9)),0.62)*0.95);
    col=mix(col,VIO(),blob(rp,vec2(0.5,-0.3+0.12*cos(t*0.7)),0.66)*0.95);
    col=mix(col,CYAN(),blob(rp,vec2(0.15*sin(t*0.6),-0.55),0.42)*0.7);
    col=mix(col,MINT()*1.05,blob(rp,vec2(0.35*cos(t*0.8),0.5),0.3)*0.6);
    col=mix(col,AMB(),u_bneed*(0.08+0.18*heart)*smoothstep(0.55,1.0,length(ip)));
    float nb=inside>0.0?snoise(vec3(ip*1.7,t*0.3))*0.5+0.5:0.5;
    col*=0.86+0.26*nb;
    /* glassy: rim light, soft top highlight, inner shade */
    float rim=smoothstep(0.62,1.0,length(ip));
    vec3 rimc=mix(MINT(),VIO(),0.5+0.5*sin(an+spin*1.3));
    if(u_bthink>0.0){ float arc=pow(0.5+0.5*cos(an-spin*2.4),10.0); rimc=mix(rimc,vec3(1.0),arc*u_bthink*0.7); }
    rimc=mix(rimc,AMB(),u_bneed*0.35);
    col=mix(col,rimc*1.2,rim*0.55);
    float hl=blob(ip,vec2(-0.32,0.42),0.34);
    col+=vec3(1.0)*hl*mix(0.28,0.22,u_light);
    float orbA=inside*mix(0.96,0.94,u_light);

    /* outer glow */
    float out_=max(r-R,0.0);
    float glow=exp(-out_*mix(5.0,9.0,u_light))*(1.0-inside)*mix(0.42,0.20,u_light)*(1.0+0.35*u_bneed*heart+0.5*u_amp*u_bw);
    vec3 glc=mix(mix(MINT(),VIO(),0.5+0.5*sin(an+t*0.4)),AMB(),u_bneed*0.9);

    /* delegating droplets */
    float drop=0.0;
    if(u_bdel>0.003) for(int i=0;i<4;i++){
      float fi=float(i); float f=fract(t*0.55+fi*0.25);
      vec2 cpos=u_ddir*(Rb+0.1+f*1.25)+vec2(-u_ddir.y,u_ddir.x)*sin(f*6.0+fi)*0.06;
      drop+=blob(p,cpos,0.07*(1.0-f*0.6))*(1.0-f)*u_bdel;
    }

    /* ---- Siri waves ---- */
    float W=0.0; vec3 wc=vec3(0.0);
    float x=p.x/1.55; float env=pow(max(1.0-x*x,0.0),2.2);
    if(wave>0.003 && env>0.0) for(int i=0;i<4;i++){
      float fi=float(i);
      float fr=2.0+fi*0.85; float spd=1.9+fi*0.6; float ph=fi*1.9;
      float A=(0.22+0.6*u_amp*(0.6+0.4*sin(t*2.3+fi*2.1)))*(1.0-fi*0.17)*mix(1.0,0.6,u_bl*(1.0-u_bw));
      float h=abs(env*A*sin(x*fr*PI*0.5+t*spd+ph));
      float band=smoothstep(h+px*1.5,h-px*1.5,abs(p.y))*step(0.001,env);
      vec3 c=fi<0.5?MINT():fi<1.5?VIO():fi<2.5?CYAN():mix(MINT(),VIO(),0.5);
      float soft=exp(-max(abs(p.y)-h,0.0)*28.0)*env*(1.0-band)*mix(0.16,0.08,u_light);
      float a=band*mix(0.46,0.40,u_light)+soft;
      wc=wc*(1.0-a)+c*a; W=W+a*(1.0-W);
    }
    float line=wave>0.003?smoothstep(px*2.5,0.0,abs(p.y))*env:0.0;
    wc=mix(wc,mix(vec3(0.85,1.0,0.95),MINT(),u_light),line*0.8); W=max(W,line*0.8);
    wc*=wave; W*=wave;

    /* compose (premultiplied) */
    vec4 o=vec4(glc*glow,glow);
    vec4 orb=vec4(col*orbA,orbA);
    o=orb+o*(1.0-orbA);
    float ko=mix(1.0,0.75,orbA);
    o=vec4(wc*ko,W*ko)+o*(1.0-W*ko);
    vec3 dc=mix(vec3(0.75,1.0,0.92),MINT(),u_light);
    float da=clamp(drop,0.0,1.0);
    o=vec4(dc*da,da)+o*(1.0-da);
    gl_FragColor=o;
  }`;


  var TARGETS = {
    A: { idle: {}, listening: { rip: 1 }, thinking: { knot: 1, think: 1 }, delegating: { deleg: 1, think: 0.3 }, speaking: { pulse: 1 }, needs: { need: 1 } },
    C: { idle: {}, listening: { line: 1 }, thinking: { gal: 1, think: 1 }, delegating: { deleg: 1 }, speaking: { wave: 1 }, needs: { need: 1 } },
    B: { idle: {}, listening: { bl: 1 }, thinking: { bthink: 1 }, delegating: { bdel: 1 }, speaking: { bw: 1 }, needs: { bneed: 1 } },
  };
  var KEYS = ["rip", "knot", "gal", "line", "wave", "pulse", "need", "deleg", "think", "bw", "bl", "bthink", "bdel", "bneed"];
  var STATES = ["idle", "listening", "thinking", "delegating", "speaking", "needs"];
  var PI = Math.PI;

  /* speech-like amplitude, for previews and when no real level is given:
     syllables inside phrases, with breaths between */
  function synthAmp(t) {
    var phrase = Math.sin(t * 0.9) * 0.5 + 0.5 > 0.18 ? 1 : 0.1;
    var syl = Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1.2));
    return Math.min(1, (0.18 + 0.75 * syl + 0.12 * Math.sin(t * 17.0)) * phrase);
  }
  function concept(c) { c = String(c || "").toUpperCase(); return c === "A" || c === "B" || c === "C" ? c : "C"; }

  /** Points on a sphere, evenly spread (golden angle) with a little jitter, and two randoms each. */
  function points(n) {
    var dir = new Float32Array(n * 3), rnd = new Float32Array(n * 2);
    var ga = PI * (3 - Math.sqrt(5)), seed = 7;
    function rand() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var i = 0; i < n; i++) {
      var y = 1 - (i + 0.5) / n * 2, rad = Math.sqrt(1 - y * y), th = ga * i;
      var x = Math.cos(th) * rad + (rand() - 0.5) * 0.035, yy = y + (rand() - 0.5) * 0.035, z = Math.sin(th) * rad + (rand() - 0.5) * 0.035;
      var l = Math.hypot(x, yy, z);
      dir[i * 3] = x / l; dir[i * 3 + 1] = yy / l; dir[i * 3 + 2] = z / l;
      rnd[i * 2] = rand(); rnd[i * 2 + 1] = rand();
    }
    return { dir: dir, rnd: rnd, n: n };
  }

  window.MintCore = function (canvas, opts) {
    opts = opts || {};
    var reduceMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var S = {
      concept: concept(opts.concept), state: "idle", amp: 0, t: 0, rot: 0, c: [0, 0], R: 200, light: 0, dpr: 1, scale: 1,
      running: false, wanted: false, still: !!(reduceMq && reduceMq.matches), frames: [], gl: false, halfRes: false, cssW: 0, cssH: 0,
    };
    var W = {};
    KEYS.forEach(function (k) { W[k] = 0; });
    var gl = null, pt = null, fl = null, P = null, bufDir = null, bufRnd = null, quad = null, raf = 0, last = 0, ctx = null, P2 = null;
    var destFn = opts.dest || null, onFrame = opts.onFrame || null, ampFn = opts.amp || null;
    var lastSize = null;

    /* ---------------------------------------------------------- WebGL */
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
      return s;
    }
    function prog(vs, fs) {
      var p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
      var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < n; i++) { var a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
      return { p: p, u: u, aDir: gl.getAttribLocation(p, "a_dir"), aRnd: gl.getAttribLocation(p, "a_rnd"), aP: gl.getAttribLocation(p, "a_p") };
    }
    function initGL() {
      if (opts.force2d) return false;
      try {
        gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: !!opts.preserve });
        if (!gl) return false;
        pt = prog(PT_VS, PT_FS);
        fl = prog(FL_VS, FL_FS);
        P = points(opts.points || 4200);
        bufDir = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufDir); gl.bufferData(gl.ARRAY_BUFFER, P.dir, gl.STATIC_DRAW);
        bufRnd = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufRnd); gl.bufferData(gl.ARRAY_BUFFER, P.rnd, gl.STATIC_DRAW);
        quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        gl.enable(gl.BLEND);
        return true;
      } catch (e) {
        if (window.console) console.warn("[core] WebGL unavailable, drawing in 2D:", e && e.message);
        gl = null;
        // A canvas that has handed out a WebGL context will never give a 2D
        // one: draw the fallback on a fresh copy of it.
        if (canvas.parentNode) {
          var fresh = canvas.cloneNode(false);
          canvas.parentNode.replaceChild(fresh, canvas);
          canvas = fresh;
        }
        return false;
      }
    }
    function drawGL(dest) {
      var dpr = S.dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      var light = S.light, u;
      if (S.concept === "B") {
        gl.useProgram(fl.p); u = fl.u;
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform2f(u.u_res, canvas.width, canvas.height); gl.uniform2f(u.u_c, S.c[0], S.c[1]); gl.uniform1f(u.u_R, S.R);
        gl.uniform1f(u.u_t, S.t); gl.uniform1f(u.u_amp, S.amp); gl.uniform1f(u.u_light, light); if (u.u_dpr) gl.uniform1f(u.u_dpr, dpr);
        gl.uniform1f(u.u_bw, W.bw); gl.uniform1f(u.u_bl, W.bl); gl.uniform1f(u.u_bthink, W.bthink); gl.uniform1f(u.u_bdel, W.bdel); gl.uniform1f(u.u_bneed, W.bneed);
        var dx = dest[0] - S.c[0], dy = -(dest[1] - S.c[1]), L = Math.hypot(dx, dy) || 1;
        gl.uniform2f(u.u_ddir, dx / L, dy / L);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(fl.aP); gl.vertexAttribPointer(fl.aP, 2, gl.FLOAT, false, 0, 0);
        // Only the region round the core is shaded.
        var ex = S.R * 2.2, ey = S.R * 1.4;
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(Math.max(0, Math.floor(S.c[0] - ex)), Math.max(0, Math.floor(canvas.height - S.c[1] - ey)), Math.ceil(ex * 2), Math.ceil(ey * 2));
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.disable(gl.SCISSOR_TEST);
        gl.disableVertexAttribArray(fl.aP);
        return;
      }
      gl.useProgram(pt.p); u = pt.u;
      if (light > 0.5) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); else gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform2f(u.u_res, canvas.width, canvas.height); gl.uniform2f(u.u_c, S.c[0], S.c[1]); gl.uniform1f(u.u_R, S.R); gl.uniform1f(u.u_dpr, dpr);
      gl.uniform1f(u.u_t, S.t); gl.uniform1f(u.u_rot, S.rot); gl.uniform1f(u.u_amp, S.amp); gl.uniform1f(u.u_light, light);
      if (u.u_mode) gl.uniform1f(u.u_mode, S.concept === "C" ? 1 : 0);
      ["rip", "knot", "gal", "line", "wave", "pulse", "need", "deleg", "think"].forEach(function (k) { if (u["u_" + k]) gl.uniform1f(u["u_" + k], W[k]); });
      gl.uniform2f(u.u_dest, dest[0], dest[1]);
      gl.uniform1f(u.u_size, (S.R / dpr < 170 ? 0.9 : 1.0) * (light > 0.5 ? 1.12 : 1.0));
      gl.bindBuffer(gl.ARRAY_BUFFER, bufDir); gl.enableVertexAttribArray(pt.aDir); gl.vertexAttribPointer(pt.aDir, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufRnd); gl.enableVertexAttribArray(pt.aRnd); gl.vertexAttribPointer(pt.aRnd, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, P.n);
      gl.disableVertexAttribArray(pt.aDir); gl.disableVertexAttribArray(pt.aRnd);
    }

    /* ---------------------------------------------------------- Canvas 2D
       The same ideas, lighter: fewer dots, no noise field, gradients for B. */
    var MINT = [0, 230, 165], CYAN = [64, 199, 196], VIO = [153, 77, 255], AMB = [250, 189, 77];
    var MINT_L = [0, 143, 102], CYAN_L = [8, 128, 143], VIO_L = [115, 33, 196], AMB_L = [204, 115, 0];
    function mix3(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
    function rgba(c, a) { return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + a.toFixed(3) + ")"; }
    function draw2d(dest) {
      var w = canvas.width, h = canvas.height, t = S.t, lt = S.light > 0.5;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var cx = S.c[0], cy = S.c[1], R = S.R;
      var mint = lt ? MINT_L : MINT, cyan = lt ? CYAN_L : CYAN, vio = lt ? VIO_L : VIO, amb = lt ? AMB_L : AMB;
      if (S.concept === "B") {
        var wave = Math.min(1, W.bw + W.bl * 0.75);
        var heart = Math.pow(Math.max(Math.sin(t * 2.2), 0), 6);
        var rb = R * 0.8 * (1 + 0.025 * Math.sin(t * 1.1) + 0.03 * heart * W.bneed) * (1 - 0.6 * wave);
        var gx = cx + Math.cos(t * 0.7) * rb * 0.3, gy = cy + Math.sin(t * 0.9) * rb * 0.3;
        var glow = ctx.createRadialGradient(cx, cy, rb * 0.9, cx, cy, rb * 1.9);
        glow.addColorStop(0, rgba(mix3(mint, amb, W.bneed * 0.9), lt ? 0.16 : 0.3)); glow.addColorStop(1, rgba(vio, 0));
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, rb * 1.9, 0, PI * 2); ctx.fill();
        var g = ctx.createRadialGradient(gx - rb * 0.3, gy - rb * 0.3, rb * 0.1, cx, cy, rb);
        g.addColorStop(0, rgba(mint, 0.95)); g.addColorStop(0.55, rgba(cyan, 0.9)); g.addColorStop(1, rgba(mix3(vio, amb, W.bneed * 0.4), 0.95));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, rb, 0, PI * 2); ctx.fill();
        if (wave > 0.01) {
          var cols = [mint, vio, cyan];
          for (var k = 0; k < 3; k++) {
            ctx.beginPath();
            for (var x = -1; x <= 1.0001; x += 0.02) {
              var env = Math.pow(Math.max(1 - x * x, 0), 2.2);
              var A = (0.22 + 0.6 * S.amp) * (1 - k * 0.17) * R;
              var y = env * A * Math.sin(x * (2 + k * 0.85) * PI * 0.5 + t * (1.9 + k * 0.6) + k * 1.9) * wave;
              var px = cx + x * R * 1.55, py = cy + y;
              if (x === -1) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.strokeStyle = rgba(cols[k], 0.75 * wave); ctx.lineWidth = 2 * S.dpr; ctx.stroke();
          }
        }
        if (W.bdel > 0.01) {
          var ddx = dest[0] - cx, ddy = dest[1] - cy, dl = Math.hypot(ddx, ddy) || 1;
          for (var q = 0; q < 4; q++) {
            var f = (t * 0.55 + q * 0.25) % 1, d = rb + f * (dl - rb);
            ctx.fillStyle = rgba(mint, (1 - f) * W.bdel);
            ctx.beginPath(); ctx.arc(cx + ddx / dl * d, cy + ddy / dl * d, 5 * S.dpr * (1 - f * 0.6), 0, PI * 2); ctx.fill();
          }
        }
        return;
      }
      var n = P2.n, dir = P2.dir, rnd = P2.rnd, rot = S.rot, cr = Math.cos(rot), sr = Math.sin(rot);
      var tx = 0.3 * (1 - W.knot) * (1 - W.gal) * (1 - W.line) * (1 - W.wave), ctx_ = Math.cos(tx), stx = Math.sin(tx);
      var heart2 = Math.pow(Math.max(Math.sin(t * 2.2), 0), 6);
      var size = Math.max(1, 1.6 * S.dpr * (R / S.dpr < 170 ? 0.9 : 1));
      for (var i = 0; i < n; i++) {
        var dx0 = dir[i * 3], dy0 = dir[i * 3 + 1], dz0 = dir[i * 3 + 2], r1 = rnd[i * 2], r2 = rnd[i * 2 + 1];
        var lat = Math.acos(Math.max(-1, Math.min(1, dy0))), lon = Math.atan2(dz0, dx0);
        var ang = Math.acos(Math.max(-1, Math.min(1, -sr * dx0 + cr * dz0)));
        var r = 1 + 0.022 * Math.sin(t * 1.05) + 0.03 * Math.sin(lat * 5 + t * 0.7) * (1 + W.think);
        r += W.rip * (0.03 + 0.24 * S.amp) * Math.sin(ang * 8 - t * 7) * Math.exp(-ang * 0.6);
        r += W.pulse * (0.03 + S.amp * 0.26) * (0.5 + 0.5 * Math.sin(ang * 3 - t * 10));
        r *= 1 - 0.12 * W.deleg;
        var x0 = dx0 * r, y0 = dy0 * r, z0 = dz0 * r;
        var X = cr * x0 + sr * z0, Y = y0, Z = -sr * x0 + cr * z0;
        // needs: gather into latitude rings
        if (W.need > 0.01) {
          var latQ = (Math.floor(lat / PI * 12) + 0.5) / 12 * PI, lo = lon + rot * 0.6, rr = 1 + 0.05 * heart2;
          X += (Math.sin(latQ) * Math.cos(lo) * rr - X) * W.need * 0.92; Y += (Math.cos(latQ) * rr - Y) * W.need * 0.92; Z += (Math.sin(latQ) * Math.sin(lo) * rr - Z) * W.need * 0.92;
        }
        // thinking: a spinning disc (C) or a tightening twist (A)
        var th = W.gal + W.knot;
        if (th > 0.01) {
          var rr2 = Math.pow(r2, 0.7) * 1.15 + 0.08, ga = Math.floor(r1 * 2) * PI + rr2 * 3.4 - t * (0.55 / (rr2 + 0.35));
          var gX = Math.cos(ga) * rr2, gY = (r1 - 0.5) * 0.05, gZ = Math.sin(ga) * rr2;
          var gY2 = gY * Math.cos(1.05) - gZ * Math.sin(1.05), gZ2 = gY * Math.sin(1.05) + gZ * Math.cos(1.05);
          var kk = Math.min(1, th) * (W.gal > W.knot ? 1 : 0.55);
          X += (gX - X) * kk; Y += (gY2 - Y) * kk; Z += (gZ2 - Z) * kk;
        }
        // C listening / speaking: a line, then waves, made of dots
        var lx = lon / PI, env = Math.pow(Math.max(1 - lx * lx, 0), 1.6);
        if (W.line > 0.01) {
          var ly = env * (0.14 + S.amp) * (0.34 * Math.sin(lx * 11 + t * 8) + 0.22 * Math.sin(lx * 23 - t * 11));
          X += (lx * 1.45 - X) * W.line; Y += (ly - Y) * W.line; Z += ((r1 - 0.5) * 0.05 - Z) * W.line;
        }
        if (W.wave > 0.01) {
          var rib = Math.floor(r1 * 4), amp_ = (0.26 + 0.5 * S.amp) * (1 - rib * 0.16);
          var wy = env * amp_ * Math.sin(lx * (2.2 + rib * 0.9) * PI * 0.5 + t * (2.4 + rib * 0.7) + rib * 1.7) * (r2 * 2 - 1 > 0 ? 1 : -1) * (0.25 + 0.75 * r2);
          X += (lx * 1.5 - X) * W.wave; Y += (wy - Y) * W.wave; Z += ((rib - 1.5) * 0.07 - Z) * W.wave;
        }
        var Y2 = Y * ctx_ - Z * stx, Z2 = Y * stx + Z * ctx_;
        var persp = 3.3 / (3.3 - Z2);
        var sx = cx + X * R * persp, sy = cy - Y2 * R * persp;
        var sel = r1 < 0.24 ? W.deleg : 0, fz = 0;
        if (sel > 0.01) {
          fz = (t * 0.42 + r2 * 3) % 1;
          var fe = fz * fz * (3 - 2 * fz);
          sx += (sx + (dest[0] - sx) * fe - sx) * sel; sy += (sy + (dest[1] - sy) * fe - sy) * sel;
        }
        var depth = Math.max(0, Math.min(1, (Z2 + 1.25) / 2.5));
        var flat = Math.max(W.line, W.wave, W.gal * 0.6);
        depth = depth + (0.75 - depth) * flat;
        var gcol = Math.max(0, Math.min(1, 0.5 + 0.62 * (X * 0.6 + Y2 * 0.6) + 0.3 * W.think));
        var col = gcol < 0.5 ? mix3(mint, cyan, gcol * 2) : mix3(cyan, vio, (gcol - 0.5) * 2);
        if (W.need > 0.01 && (Math.floor(lat / PI * 12) % 2)) col = mix3(col, amb, Math.min(1, W.need * (0.55 + 0.45 * heart2)));
        var a = (lt ? 0.16 : 0.07) + (1 - (lt ? 0.16 : 0.07)) * Math.pow(depth, 1.4);
        if (sel > 0.01) a *= 1 - Math.max(0, (fz - 0.82) / 0.18) * 0.9 * sel;
        ctx.fillStyle = rgba(col, Math.min(1, a));
        var sz = size * (0.6 + 1.2 * depth * depth) * persp;
        ctx.fillRect(sx - sz / 2, sy - sz / 2, sz, sz);
      }
    }

    /* ---------------------------------------------------------- the loop */
    function step(dt) {
      S.t += dt;
      var tg = TARGETS[S.concept][S.state] || {};
      var k = 1 - Math.exp(-dt * 2.6);
      KEYS.forEach(function (key) { W[key] += ((tg[key] || 0) - W[key]) * k; });
      var talking = S.state === "listening" || S.state === "speaking";
      var real = talking && ampFn ? ampFn(S.state) : null;
      var target = !talking ? 0 : real == null || real < 0 ? (ampFn && !opts.autoAmp ? 0.35 : synthAmp(S.t)) : Math.max(0, Math.min(1, real));
      S.amp += (target - S.amp) * (1 - Math.exp(-dt * 14));
      S.rot += dt * (0.13 + 0.25 * W.think + 0.1 * W.deleg);
    }
    function dest() {
      var dpr = S.dpr, d = destFn ? destFn() : null;
      if (!d) d = [S.c[0] / dpr + 300, S.c[1] / dpr - 200];
      return [d[0] * dpr, d[1] * dpr];
    }
    function draw() {
      if (!canvas.width || !canvas.height) return;
      if (gl) drawGL(dest()); else if (ctx) draw2d(dest());
      if (onFrame) onFrame(S, W);
    }
    function frame(now) {
      raf = 0;
      if (!S.running) return;
      var dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
      last = now;
      var t0 = performance.now();
      step(dt);
      draw();
      var cost = performance.now() - t0;
      S.frames.push([now, cost]);
      if (S.frames.length > 120) S.frames.shift();
      if (S.concept === "B" && gl && !S.halfRes && S.frames.length >= 90 && S.frames.length % 30 === 0) guardB();
      raf = requestAnimationFrame(frame);
    }
    /* B shades every pixel round the core: if frames come slower than ~45 fps,
       draw it at half resolution (the canvas is scaled back up by CSS). */
    function guardB() {
      var st = stats();
      if (st && st.interval > 22) {
        S.halfRes = true;
        S.scale = 0.5;
        if (lastSize) resize.apply(null, lastSize);
        if (window.console) console.info("[core] concept B at half resolution (" + st.interval.toFixed(1) + " ms a frame)");
      }
    }
    function start() {
      S.wanted = true;
      if (S.still) { stillFrame(); return; }
      if (document.hidden || S.running) return;
      S.running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    }
    function stop(keepWanted) {
      if (!keepWanted) S.wanted = false;
      S.running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
    /* Reduced motion: jump the weights to the state's targets, one frame. */
    function stillFrame() {
      var tg = TARGETS[S.concept][S.state] || {};
      KEYS.forEach(function (k) { W[k] = tg[k] || 0; });
      S.amp = S.state === "listening" || S.state === "speaking" ? 0.55 : 0;
      if (S.t === 0) S.t = 2.4;
      draw();
    }
    function onVisibility() {
      if (document.hidden) stop(true);
      else if (S.wanted) start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    if (reduceMq && reduceMq.addEventListener) {
      reduceMq.addEventListener("change", function () {
        S.still = reduceMq.matches;
        if (S.still) { stop(true); stillFrame(); } else if (S.wanted) start();
      });
    }

    /**
     * Where the core sits and how big: centre and radius in CSS pixels; the
     * canvas's own CSS size (or the window's, for a full-page canvas).
     */
    function resize(cx, cy, R, w, h) {
      lastSize = [cx, cy, R, w, h];
      var dpr = Math.min(window.devicePixelRatio || 1, 2) * S.scale;
      w = w || canvas.clientWidth || window.innerWidth;
      h = h || canvas.clientHeight || window.innerHeight;
      var pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      S.cssW = w; S.cssH = h;
      S.c = [cx * dpr, cy * dpr];
      S.R = R * dpr;
      S.dpr = dpr;
      if (S.still || !S.running) draw();
    }
    function stats() {
      var f = S.frames;
      if (f.length < 10) return null;
      var cost = f.map(function (x) { return x[1]; }).sort(function (a, b) { return a - b; });
      var iv = [];
      for (var i = 1; i < f.length; i++) iv.push(f[i][0] - f[i - 1][0]);
      iv.sort(function (a, b) { return a - b; });
      var med = function (a) { return a[Math.floor(a.length / 2)]; }, p95 = function (a) { return a[Math.floor(a.length * 0.95)]; };
      return { cpuMean: cost.reduce(function (a, b) { return a + b; }, 0) / cost.length, cpuMed: med(cost), cpuP95: p95(cost), interval: med(iv), intervalP95: p95(iv), fps: 1000 / med(iv), n: f.length, gl: !!gl, halfRes: S.halfRes };
    }

    if (initGL()) S.gl = true;
    else {
      ctx = canvas.getContext("2d");
      P2 = points(opts.points2d || 900);
    }

    return {
      S: S, W: W, STATES: STATES,
      get isGL() { return !!gl; },
      get canvas() { return canvas; },
      setState: function (s) {
        if (STATES.indexOf(s) < 0) s = "idle";
        if (s === S.state) return;
        S.state = s;
        if (S.still) stillFrame();
      },
      setConcept: function (c) {
        c = concept(c);
        if (c === S.concept) return;
        S.concept = c;
        S.frames = [];
        if (S.halfRes) { S.halfRes = false; S.scale = 1; if (lastSize) resize.apply(null, lastSize); }
        if (S.still || !S.running) stillFrame();
      },
      setLight: function (on) { S.light = on ? 1 : 0; if (S.still || !S.running) draw(); },
      resize: resize,
      start: start,
      stop: function () { stop(false); },
      still: stillFrame,
      stats: stats,
      draw: draw,
    };
  };
})();
