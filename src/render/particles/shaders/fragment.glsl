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
    // Photo colors + mild display lift (sampling already applies soft exposure)
    color = vColor * 1.08 + vec3(0.022);
    color = min(color, vec3(1.0));
    color = mix(color, vec3(1.0), clamp(vRipple * 0.22, 0., 0.4));
    // Opaque at rest so black clear doesn’t muddy through soft point edges
    float dustFade = mix(1.0, 0.52, clamp(vDistance * 0.4, 0., 1.));
    alpha = circ.r * dustFade * (1.0 + vRipple * 0.3);
  } else {
    color = mix(startColor, endColor, vDistance);
    color = mix(color, vec3(1.0), clamp(vRipple * 0.65, 0., 1.));
    alpha = circ.r * vDistance * (1.0 + vRipple * 0.85);
  }

  gl_FragColor = vec4(color, alpha);
}
