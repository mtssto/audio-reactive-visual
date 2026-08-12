varying float vDistance;
varying float vRipple;
varying vec3 vColor;
varying float vImageMode;

uniform vec3 startColor;
uniform vec3 endColor;

float circle(in vec2 _st,in float _radius){
  vec2 dist=_st-vec2(.5);
  return 1.-smoothstep(_radius-(_radius*.01),
  _radius+(_radius*.01),
  dot(dist,dist)*4.);
}

void main(){
  vec2 uv = vec2(gl_PointCoord.x,1.-gl_PointCoord.y);
  vec3 circ = vec3(circle(uv,1.));

  vec3 color;
  float alpha;

  if (vImageMode > 0.5) {
    // Keep photo colors literal (sRGB sample → display)
    color = vColor;
    color = mix(color, vec3(1.0), clamp(vRipple * 0.28, 0., 0.45));
    // Near-opaque at rest so the stipple reads as a photo; softens when dusted
    float dustFade = mix(0.98, 0.48, clamp(vDistance * 0.4, 0., 1.));
    alpha = circ.r * dustFade * (1.0 + vRipple * 0.35);
  } else {
    color = mix(startColor, endColor, vDistance);
    color = mix(color, vec3(1.0), clamp(vRipple * 0.65, 0., 1.));
    alpha = circ.r * vDistance * (1.0 + vRipple * 0.85);
  }

  gl_FragColor = vec4(color, alpha);
}
