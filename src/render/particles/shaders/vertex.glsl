varying float vDistance;
varying float vRipple;

uniform float time;
uniform float offsetSize;
uniform float size;
uniform float offsetGain;
uniform float amplitude;
uniform float frequency;
uniform float maxDistance;

uniform vec2 uTouchNdc[4];
uniform float uTouchStrength[4];
uniform float uTouchAge[4];
uniform float uTouchRadius;

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
  vec3 newpos = position;
  vec3 target = position + (normal*.1) + curl(newpos.x * frequency, newpos.y * frequency, newpos.z * frequency) * amplitude;

  float d = length(newpos - target) / maxDistance;
  newpos = mix(position, target, pow(d, 4.));
  newpos.z += sin(time) * (.1 * offsetGain);

  vec4 mvPosition = modelViewMatrix * vec4(newpos, 1.);
  vec4 clip = projectionMatrix * mvPosition;
  vec2 ndc = clip.xy / max(clip.w, 0.0001);

  float scatterBoost = 0.;
  float ripple = 0.;
  float radius = max(uTouchRadius, 0.02);

  for (int i = 0; i < 4; i++) {
    float str = uTouchStrength[i];
    if (str < 0.001) continue;

    vec2 delta = ndc - uTouchNdc[i];
    float dist = length(delta);
    float falloff = exp(-(dist * dist) / (radius * radius));
    float ageFade = exp(-uTouchAge[i] * 2.2);
    float impulse = str * falloff * ageFade;

    // Expanding ripple ring
    float ring = abs(dist - uTouchAge[i] * 0.55);
    float ringPulse = exp(-(ring * ring) / 0.004) * str * ageFade;

    if (dist > 0.0001) {
      vec2 dir = delta / dist;
      mvPosition.xy += dir * impulse * 1.35;
    }

    scatterBoost += impulse;
    ripple += ringPulse + impulse * 0.35;
  }

  gl_PointSize = (size + (pow(d,3.) * offsetSize) * (1./-mvPosition.z)) * (1. + scatterBoost * 2.4);
  gl_Position = projectionMatrix * mvPosition;

  vDistance = d;
  vRipple = clamp(ripple, 0., 2.);
}
