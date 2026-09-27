import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode,
  ChromaticAberrationEffect, VignetteEffect, NoiseEffect, BlendFunction, HueSaturationEffect,
  BrightnessContrastEffect, SMAAEffect, SMAAPreset,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { LightManager } from './lights';
import { VolumetricPass } from './volumetric';
import { WetFloorPass } from './ssr';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityCfg { pixelRatio: number; ao: boolean; volSteps: number; volHalf: boolean; ssr: boolean; shadows: boolean; bloom: boolean; particles: number }
export const QUALITY: Record<Quality, QualityCfg> = {
  low: { pixelRatio: 0.66, ao: false, volSteps: 0, volHalf: true, ssr: false, shadows: false, bloom: true, particles: 0.4 },
  medium: { pixelRatio: 0.85, ao: false, volSteps: 12, volHalf: true, ssr: false, shadows: true, bloom: true, particles: 0.7 },
  high: { pixelRatio: 1, ao: true, volSteps: 18, volHalf: true, ssr: true, shadows: true, bloom: true, particles: 1 },
  ultra: { pixelRatio: 1.25, ao: true, volSteps: 28, volHalf: false, ssr: true, shadows: true, bloom: true, particles: 1.3 },
};

/** Renderer, camera, post stack. Screen-feedback knobs (CA, desaturation, vignette) are driven by the game. */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly lights = new LightManager();
  composer!: EffectComposer;
  private ao?: N8AOPostPass;
  volumetric!: VolumetricPass;
  wet!: WetFloorPass;
  private bloom!: BloomEffect;
  private ca!: ChromaticAberrationEffect;
  private hue!: HueSaturationEffect;
  private bc!: BrightnessContrastEffect;
  private vignette!: VignetteEffect;
  quality: Quality = 'high';
  cfg: QualityCfg = QUALITY.high;
  /** 0..1 amount of chromatic aberration pulse, decays each frame */
  caPulse = 0;
  /** 0..1 desaturation (bullet time) */
  desat = 0;
  /** sector grade */
  grade = { hue: 0, sat: 0.05, contrast: 0.08, bright: 0 };
  hFov = 103;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 220);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.scene.background = new THREE.Color(0x010103);
    this.buildComposer();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private buildComposer() {
    const r = this.renderer;
    this.composer?.dispose();
    const c = new EffectComposer(r, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer = c;
    c.addPass(new RenderPass(this.scene, this.camera));
    if (this.cfg.ao) {
      const ao = new N8AOPostPass(this.scene, this.camera, 1, 1);
      ao.configuration.aoRadius = 1.6;
      ao.configuration.distanceFalloff = 1.0;
      ao.configuration.intensity = 3.0;
      ao.configuration.halfRes = true;
      ao.configuration.depthAwareUpsampling = true;
      ao.configuration.gammaCorrection = false;
      ao.setQualityMode('Medium');
      this.ao = ao;
      c.addPass(ao);
    } else this.ao = undefined;
    this.wet = new WetFloorPass(this.camera, this.lights);
    this.wet.enabled = this.cfg.ssr;
    c.addPass(this.wet);
    this.volumetric = new VolumetricPass(this.camera, this.lights, this.cfg.volSteps, this.cfg.volHalf);
    this.volumetric.enabled = this.cfg.volSteps > 0;
    c.addPass(this.volumetric);

    this.bloom = new BloomEffect({ mipmapBlur: true, intensity: 1.35, luminanceThreshold: 0.85, luminanceSmoothing: 0.25, radius: 0.72, levels: 7 } as any);
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    this.hue = new HueSaturationEffect({ hue: 0, saturation: 0 });
    this.bc = new BrightnessContrastEffect({ brightness: 0, contrast: 0.08 });
    c.addPass(new EffectPass(this.camera, this.bloom, tone));
    this.ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0, 0.0), radialModulation: true, modulationOffset: 0.15 });
    this.vignette = new VignetteEffect({ darkness: 0.62, offset: 0.28 });
    const noise = new NoiseEffect({ premultiply: false, blendFunction: BlendFunction.OVERLAY });
    noise.blendMode.opacity.value = 0.09;
    const smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM });
    c.addPass(new EffectPass(this.camera, smaa, this.hue, this.bc, this.vignette, noise));
    c.addPass(new EffectPass(this.camera, this.ca));
    this.resize();
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.cfg = QUALITY[q];
    this.renderer.shadowMap.enabled = this.cfg.shadows;
    this.buildComposer();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio, 2) * this.cfg.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.setHFov(this.hFov);
    this.composer?.setSize(w, h, false);
  }

  setHFov(h: number) {
    this.hFov = h;
    const v = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(h) / 2) / this.camera.aspect);
    this.camera.fov = THREE.MathUtils.radToDeg(v);
    this.camera.updateProjectionMatrix();
  }

  get drawSize() { const v = new THREE.Vector2(); this.renderer.getDrawingBufferSize(v); return v; }

  render(realDt: number, simDt: number) {
    const size = this.drawSize;
    this.camera.updateMatrixWorld();
    this.lights.update(simDt, this.camera, size.x, size.y);
    this.caPulse = Math.max(0, this.caPulse - realDt * 3.5);
    const caAmt = 0.0006 + this.caPulse * 0.012 + this.desat * 0.004;
    this.ca.offset.set(caAmt, caAmt * 0.6);
    this.hue.saturation = this.grade.sat - this.desat * 0.75;
    this.hue.hue = this.grade.hue;
    this.bc.contrast = this.grade.contrast + this.desat * 0.1;
    this.bc.brightness = this.grade.bright;
    this.vignette.darkness = 0.62 + this.desat * 0.25;
    this.volumetric.time += realDt;
    this.composer.render(realDt);
  }
}
