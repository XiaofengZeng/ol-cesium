/**
 * @module olcs.SynchronizedOverlay
 */
import * as olBase from 'ol/index.js';
import olOverlay from 'ol/Overlay.js';
import * as olProj from 'ol/proj.js';
import * as olDom from 'ol/dom.js';
import {unByKey as olObservableUnByKey} from 'ol/Observable.js';

class exports extends olOverlay {
  /**
   * @constructor
   * @param {olcsx.SynchronizedOverlayOptions} options SynchronizedOverlay Options.
   * @api
   */
  constructor(options) {
    const parent = options.parent;
    super(parent.getOptions());

    /**
     * @private
     * @type {?Function}
     */
    this.scenePostRenderListenerRemover_ = null;

    /**
     * @private
     * @type {!Cesium.Scene}
     */
    this.scene_ = options.scene;

    /**
     * @private
     * @type {!olcs.OverlaySynchronizer}
     */
    this.synchronizer_ = options.synchronizer;

    /**
     * @private
     * @type {!ol.Overlay}
     */
    this.parent_ = parent;

    /**
     * @private
     * @type {ol.Coordinate|undefined}
     */
    this.positionWGS84_ = undefined;

    /**
     * @private
     * @type {MutationObserver}
     */
    this.observer_ = new MutationObserver(this.handleElementChanged.bind(this));

    /**
     * @private
     * @type {Array.<MutationObserver>}
     */
    this.attributeObserver_ = [];

    /**
     * @private
     * @type {Array<ol.EventsKey>}
     */
    this.listenerKeys_ = [];
    // synchronize our Overlay with the parent Overlay
    this.listenerKeys_.push(this.parent_.on('change:position', this.setPropertyFromEvent_.bind(this)));
    this.listenerKeys_.push(this.parent_.on('change:element', this.setPropertyFromEvent_.bind(this)));
    this.listenerKeys_.push(this.parent_.on('change:offset', this.setPropertyFromEvent_.bind(this)));
    this.listenerKeys_.push(this.parent_.on('change:position', this.setPropertyFromEvent_.bind(this)));
    this.listenerKeys_.push(this.parent_.on('change:positioning', this.setPropertyFromEvent_.bind(this)));

    this.setProperties(this.parent_.getProperties());

    this.handleMapChanged();
  }

  /**
   * @param {Node} target
   * @private
   */
  observeTarget_(target) {
    this.observer_.disconnect();
    this.observer_.observe(target, {
      attributes: false,
      childList: true,
      characterData: true,
      subtree: true
    });
    this.attributeObserver_.forEach((observer) => {
      observer.disconnect();
    });
    this.attributeObserver_.length = 0;
    for (let i = 0; i < target.childNodes.length; i++) {
      const node = target.childNodes[i];
      if (node.nodeType === 1) {
        const observer = new MutationObserver(this.handleElementChanged.bind(this));
        observer.observe(node, {
          attributes: true,
          subtree: true
        });
        this.attributeObserver_.push(observer);
      }
    }
  }

  /**
   *
   * @param {ol.Object.Event} event
   * @private
   */
  setPropertyFromEvent_(event) {
    if (event.target && event.key) {
      this.set(event.key, event.target.get(event.key));
    }
  }

  /**
   * Get the scene associated with this overlay.
   * @see ol.Overlay.prototype.getMap
   * @return {!Cesium.Scene} The scene that the overlay is part of.
   * @api
   */
  getScene() {
    return this.scene_;
  }

  /**
   * @override
   */
  handleMapChanged() {
    if (this.scenePostRenderListenerRemover_) {
      this.scenePostRenderListenerRemover_();
      olDom.removeNode(this.element);
    }
    this.scenePostRenderListenerRemover_ = null;
    const scene = this.getScene();
    if (scene) {
      this.scenePostRenderListenerRemover_ = scene.postRender.addEventListener(this.updatePixelPosition.bind(this));
      this.updatePixelPosition();
      const container = this.stopEvent ?
        this.synchronizer_.getOverlayContainerStopEvent() : this.synchronizer_.getOverlayContainer();
      if (this.insertFirst) {
        container.insertBefore(this.element, container.childNodes[0] || null);
      } else {
        container.appendChild(this.element);
      }
    }
  }

  /**
   * @override
   */
  handlePositionChanged() {
    // transform position to WGS84
    const position = this.getPosition();
    if (position) {
      const sourceProjection = this.parent_.getMap().getView().getProjection();
      this.positionWGS84_ = olProj.transform(position, sourceProjection, 'EPSG:4326');
    } else {
      this.positionWGS84_ = undefined;
    }
    this.updatePixelPosition();
  }

  /**
   * @override
   */
  handleElementChanged() {
    function cloneNode(node, parent) {
      const clone = node.cloneNode();
      if (parent) {
        parent.appendChild(clone);
      }
      if (node.nodeType != Node.TEXT_NODE) {
        clone.addEventListener('click', (event) => {
          node.dispatchEvent(new MouseEvent('click', event));
          event.stopPropagation();
        });
      }
      const nodes = node.childNodes;
      for (let i = 0; i < nodes.length; i++) {
        if (!nodes[i]) {
          continue;
        }
        cloneNode(nodes[i], clone);
      }
      return clone;
    }
    olDom.removeChildren(this.element);
    const element = this.getElement();
    if (element) {
      if (element.parentNode && element.parentNode.childNodes) {
        for (const node of element.parentNode.childNodes) {
          const clonedNode = cloneNode(node, null);
          this.element.appendChild(clonedNode);
        }
      }
    }
    if (element.parentNode) {
      // set new Observer
      this.observeTarget_(element.parentNode);
    }
  }

  /**
   * @override
   */
  updatePixelPosition() {
    const position = this.positionWGS84_;
    if (!this.scene_ || !position) {
      this.setVisible(false);
      return;
    }
    let cartesian;
    if (position.length === 2) {
      cartesian = Cesium.Cartesian3.fromDegreesArray(position)[0];
    } else {
      cartesian = Cesium.Cartesian3.fromDegreesArrayHeights(position)[0];
    }
    const camera = this.scene_.camera;
    const ellipsoidBoundingSphere = new Cesium.BoundingSphere(new Cesium.Cartesian3(), 6356752);
    const occluder = new Cesium.Occluder(ellipsoidBoundingSphere, camera.position);
    // check if overlay position is behind the horizon
    if (!occluder.isPointVisible(cartesian)) {
      this.setVisible(false);
      return;
    }
    const cullingVolume = camera.frustum.computeCullingVolume(camera.position, camera.direction, camera.up);
    // check if overlay position is visible from the camera
    if (cullingVolume.computeVisibility(new Cesium.BoundingSphere(cartesian)) !== 1) {
      this.setVisible(false);
      return;
    }
    this.setVisible(true);

    const pixelCartesian = this.scene_.cartesianToCanvasCoordinates(cartesian);
    const pixel = [pixelCartesian.x, pixelCartesian.y];
    const mapSize = [this.scene_.canvas.width, this.scene_.canvas.height];
    this.updateRenderedPosition(pixel, mapSize);
  }

  /**
   * Destroys the overlay, removing all its listeners and elements
   * @api
   */
  destroy() {
    if (this.scenePostRenderListenerRemover_) {
      this.scenePostRenderListenerRemover_();
    }
    if (this.observer_) {
      this.observer_.disconnect();
    }
    olObservableUnByKey(this.listenerKeys_);
    this.listenerKeys_.splice(0);
    if (this.element.removeNode) {
      this.element.removeNode(true);
    } else {
      this.element.remove();
    }
    this.element = null;
  }
}

olBase.inherits(exports, olOverlay);


export default exports;
