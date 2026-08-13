varying float vDistance;
varying float vRipple;
varying vec3 vColor;
varying float vImageMode;

uniform float time;
uniform float offsetSize;
uniform float size;
uniform float offsetGain;
uniform float amplitude;
uniform float frequency;
uniform float maxDistance;
/** 0 = Codrops mesh, 1 = image particle cloud */
uniform float uImageMode;
/** 0–1 disintegration (image mode): home → curl dust */
uniform float uBreak;

attribute vec3 color;

uniform vec2 uTouchNdc[4];
uniform float uTouchStrength[4];
uniform float uTouchAge[4];
uniform float uTouchRadius[4];
/** 0 = scatter, 1 = wind, 2 = gather */
uniform float uTouchMode[4];

vec3 mod289(vec3 x){
  return x-floor(x*(1./289.))*289.;
}

vec2 mod289(vec2 x){
  return x-floor(x*(1./289.))*289.;
}

vec3 permute(vec3 x){
  return mod289(((x*34.)+1.)*x);
}

float noise(vec2 v) {
  const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);
  vec2 i=floor(v+dot(v,C.yy));
  vec2 x0=v-i+dot(i,C.xx);
  vec2 i1;
  i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);
  vec4 x12=x0.xyxy+C.xxzz;
  x12.xy-=i1;
  i=mod289(i);
  vec3 p=permute(permute(i.y+vec3(0.,i1.y,1.))
  +i.x+vec3(0.,i1.x,1.));
  vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);
  m=m*m;
  m=m*m;
  vec3 x=2.*fract(p*C.www)-1.;
  vec3 h=abs(x)-.5;
  vec3 ox=floor(x+.5);
  vec3 a0=x-ox;
  m*=1.79284291400159-.85373472095314*(a0*a0+h*h);
  vec3 g;
  g.x=a0.x*x0.x+h.x*x0.y;
  g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.*dot(m,g);
}

vec3 curl(float x,float y,float z) {
  float eps=1.,eps2=2.*eps;
  float n1,n2,a,b;
  x+=time*.05;
  y+=time*.05;
  z+=time*.05;
  vec3 curl=vec3(0.);
  n1=noise(vec2(x,y+eps));
  n2=noise(vec2(x,y-eps));
  a=(n1-n2)/eps2;
  n1=noise(vec2(x,z+eps));
  n2=noise(vec2(x,z-eps));
  b=(n1-n2)/eps2;
  curl.x=a-b;
  n1=noise(vec2(y,z+eps));
  n2=noise(vec2(y,z-eps));
  a=(n1-n2)/eps2;
  n1=noise(vec2(x+eps,z));
  n2=noise(vec2(x-eps,z));
  b=(n1-n2)/eps2;
  curl.y=a-b;
  n1=noise(vec2(x+eps,y));
  n2=noise(vec2(x-eps,y));
  a=(n1-n2)/eps2;
  n1=noise(vec2(y+eps,z));
  n2=noise(vec2(y-eps,z));
  b=(n1-n2)/eps2;
  curl.z=a-b;
  return curl;
}

void main() {
  vec3 newpos;
  float d;

  if (uImageMode > 0.5) {
    vec3 home = position;
    float brk = clamp(uBreak, 0., 1.);
    // Near-zero idle drift so the photo reads sharp at rest
    float breath = 0.008 * (1. - brk);
    vec3 curlOff = curl(
      home.x * frequency,
      home.y * frequency,
      home.z * frequency + color.r * 2.
    );
    // Soft outward drift as break rises (photo → dust) — keep image mode gentle
    vec3 dust = home + curlOff * amplitude * (0.38 + brk * 1.55);
    dust.z += curlOff.z * amplitude * brk * 1.9;
    newpos = mix(home + curlOff * breath, dust, brk);
    d = length(newpos - home) / max(maxDistance, 0.001);
    vColor = color;
  } else {
    vec3 target = position + (normal*.1) + curl(position.x * frequency, position.y * frequency, position.z * frequency) * amplitude;
    d = length(position - target) / maxDistance;
    newpos = mix(position, target, pow(d, 4.));
    newpos.z += sin(time) * (.1 * offsetGain);
    vColor = vec3(1.);
  }

  vec4 mvPosition = modelViewMatrix * vec4(newpos, 1.);
  vec4 clip = projectionMatrix * mvPosition;
  vec2 ndc = clip.xy / max(clip.w, 0.0001);

  float scatterBoost = 0.;
  float ripple = 0.;
  // Idle touch influence stays mild so formed photo isn't constantly shredded
  float touchBreak = uImageMode > 0.5 ? (0.14 + clamp(uBreak, 0., 1.) * 0.72) : 1.;

  for (int i = 0; i < 4; i++) {
    float str = uTouchStrength[i];
    if (str < 0.001) continue;

    float radius = max(uTouchRadius[i], 0.02);
    float mode = uTouchMode[i];
    vec2 delta = ndc - uTouchNdc[i];
    float dist = length(delta);
    float falloff = exp(-(dist * dist) / (radius * radius));
    float ageFade = exp(-uTouchAge[i] * 2.2);
    float impulse = str * falloff * ageFade * touchBreak;

    // Expanding ripple ring (stronger for scatter taps)
    float ring = abs(dist - uTouchAge[i] * 0.55);
    float ringPulse = exp(-(ring * ring) / 0.004) * str * ageFade;

    if (dist > 0.0001) {
      vec2 dir = delta / dist;
      if (mode < 0.5) {
        // Index scatter — tight outward ripple
        mvPosition.xy += dir * impulse * 1.55;
        mvPosition.z += impulse * (uImageMode > 0.5 ? 1.8 : 0.);
        scatterBoost += impulse;
        ripple += ringPulse + impulse * 0.4;
      } else if (mode < 1.5) {
        // Palm wind — wide soft push
        mvPosition.xy += dir * impulse * 0.52;
        scatterBoost += impulse * 0.35;
        ripple += impulse * 0.18;
      } else {
        // Pinch gather — pull inward + mild compress glow
        mvPosition.xy -= dir * impulse * 1.15;
        scatterBoost += impulse * 0.25;
        ripple += impulse * 0.55;
      }
    } else if (mode >= 1.5) {
      scatterBoost += impulse * 0.2;
      ripple += impulse * 0.4;
    }
  }

  float sizeBase = size + (pow(d,3.) * offsetSize) * (1./-mvPosition.z);
  if (uImageMode > 0.5) {
    // Dense stipple with overlap so black clear doesn’t show through gaps
    float z = max(0.001, -mvPosition.z);
    sizeBase = max(1.2, size * 195. / z) + offsetSize * 0.05 * d;
  }
  gl_PointSize = sizeBase * (1. + scatterBoost * 2.4);
  gl_Position = projectionMatrix * mvPosition;

  vDistance = d;
  vRipple = clamp(ripple, 0., 2.);
  vImageMode = uImageMode;
}
