import * as THREE from 'three';

/** Point that pulls nearby colonization nodes until consumed (kill radius). */
export class AttractionPoint {
  readonly position: THREE.Vector3;
  active = true;

  constructor(x: number, y: number, z: number) {
    this.position = new THREE.Vector3(x, y, z);
  }
}
