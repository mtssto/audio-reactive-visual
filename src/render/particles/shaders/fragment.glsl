varying float vDistance;
varying float vRipple;

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

  vec3 color = mix(startColor, endColor, vDistance);
  color = mix(color, vec3(1.0), clamp(vRipple * 0.65, 0., 1.));

  float alpha = circ.r * vDistance * (1.0 + vRipple * 0.85);
  gl_FragColor = vec4(color, alpha);
}
