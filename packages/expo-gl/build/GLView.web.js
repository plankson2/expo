import { CodedError, UnavailabilityError } from '@unimodules/core';
import { canUseDOM } from 'fbjs/lib/ExecutionEnvironment';
import invariant from 'invariant';
import PropTypes from 'prop-types';
import React from 'react';
import { Dimensions } from 'react-native';
import Canvas from './Canvas';
function getImageForAsset(asset) {
    if (asset != null && typeof asset === 'object' && asset !== null && asset.downloadAsync) {
        const dataURI = asset.localUri || asset.uri || '';
        const image = new Image();
        image.src = dataURI;
        return image;
    }
    return asset;
}
function isOffscreenCanvas(element) {
    return element && typeof element.convertToBlob === 'function';
}
function asExpoContext(gl) {
    gl.endFrameEXP = function glEndFrameEXP() { };
    if (!gl['_expo_texImage2D']) {
        gl['_expo_texImage2D'] = gl.texImage2D;
        gl.texImage2D = (...props) => {
            const nextProps = [...props];
            nextProps.push(getImageForAsset(nextProps.pop()));
            return gl['_expo_texImage2D'](...nextProps);
        };
    }
    if (!gl['_expo_texSubImage2D']) {
        gl['_expo_texSubImage2D'] = gl.texSubImage2D;
        gl.texSubImage2D = (...props) => {
            const nextProps = [...props];
            nextProps.push(getImageForAsset(nextProps.pop()));
            return gl['_expo_texSubImage2D'](...nextProps);
        };
    }
    return gl;
}
function ensureContext(canvas, contextAttributes) {
    if (!canvas) {
        throw new CodedError('ERR_GL_INVALID', 'Attempting to use the GL context before it has been created.');
    }
    // Apple disables WebGL 2.0 and doesn't provide any way to detect if it's disabled.
    const isIOS = !!navigator.platform && /iPad|iPhone|iPod/.test(navigator.platform);
    const context = (!isIOS && canvas.getContext('webgl2', contextAttributes)) ||
        canvas.getContext('webgl', contextAttributes) ||
        canvas.getContext('webgl-experimental', contextAttributes) ||
        canvas.getContext('experimental-webgl', contextAttributes);
    invariant(context, 'Browser does not support WebGL');
    return asExpoContext(context);
}
function stripNonDOMProps(props) {
    for (const k in propTypes) {
        if (k in props) {
            delete props[k];
        }
    }
    return props;
}
const propTypes = {
    onContextCreate: PropTypes.func.isRequired,
    onContextRestored: PropTypes.func,
    onContextLost: PropTypes.func,
    webglContextAttributes: PropTypes.object,
    /**
     * [iOS only] Number of samples for Apple's built-in multisampling.
     */
    msaaSamples: PropTypes.number,
    /**
     * A ref callback for the native GLView
     */
    nativeRef_EXPERIMENTAL: PropTypes.func,
};
async function getBlobFromWebGLRenderingContext(gl, options = {}) {
    invariant(gl, 'getBlobFromWebGLRenderingContext(): WebGL Rendering Context is not defined');
    const { canvas } = gl;
    let blob = null;
    if (typeof canvas.msToBlob === 'function') {
        // @ts-ignore: polyfill: https://stackoverflow.com/a/29815058/4047926
        blob = await canvas.msToBlob();
    }
    else if (isOffscreenCanvas(canvas)) {
        blob = await canvas.convertToBlob({ quality: options.compress, type: options.format });
    }
    else {
        blob = await new Promise(resolve => {
            canvas.toBlob((blob) => resolve(blob), options.format, options.compress);
        });
    }
    return {
        blob,
        width: canvas.width,
        height: canvas.height,
    };
}
let GLView = /** @class */ (() => {
    class GLView extends React.Component {
        constructor() {
            super(...arguments);
            this.onContextLost = (event) => {
                if (event && event.preventDefault) {
                    event.preventDefault();
                }
                this.gl = undefined;
                if (typeof this.props.onContextLost === 'function') {
                    this.props.onContextLost();
                }
            };
            this.onContextRestored = () => {
                this.gl = undefined;
                if (this.getGLContext() == null) {
                    throw new CodedError('ERR_GL_INVALID', 'Failed to restore GL context.');
                }
            };
            this.setCanvasRef = (canvas) => {
                this.canvas = canvas;
                if (typeof this.props.nativeRef_EXPERIMENTAL === 'function') {
                    this.props.nativeRef_EXPERIMENTAL(canvas);
                }
                if (this.canvas) {
                    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
                    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
                    this.getGLContext();
                }
            };
        }
        static async createContextAsync() {
            if (!canUseDOM) {
                return null;
            }
            const canvas = document.createElement('canvas');
            const { width, height, scale } = Dimensions.get('window');
            canvas.width = width * scale;
            canvas.height = height * scale;
            return ensureContext(canvas);
        }
        static async destroyContextAsync(exgl) {
            // Do nothing
            return true;
        }
        static async takeSnapshotAsync(gl, options = {}) {
            const { blob, width, height } = await getBlobFromWebGLRenderingContext(gl, options);
            if (!blob) {
                throw new CodedError('ERR_GL_SNAPSHOT', 'Failed to save the GL context');
            }
            return {
                uri: blob,
                localUri: '',
                width,
                height,
            };
        }
        componentWillUnmount() {
            if (this.gl) {
                const loseContextExt = this.gl.getExtension('WEBGL_lose_context');
                if (loseContextExt) {
                    loseContextExt.loseContext();
                }
                this.gl = undefined;
            }
            if (this.canvas) {
                this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
                this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
            }
        }
        render() {
            const domProps = stripNonDOMProps({ ...this.props });
            delete domProps.ref;
            return <Canvas {...domProps} canvasRef={this.setCanvasRef}/>;
        }
        componentDidUpdate(prevProps) {
            const { webglContextAttributes } = this.props;
            if (this.canvas && webglContextAttributes !== prevProps.webglContextAttributes) {
                this.onContextLost(null);
                this.onContextRestored();
            }
        }
        getGLContextOrReject() {
            const gl = this.getGLContext();
            if (!gl) {
                throw new CodedError('ERR_GL_INVALID', 'Attempting to use the GL context before it has been created.');
            }
            return gl;
        }
        getGLContext() {
            if (this.gl)
                return this.gl;
            if (this.canvas) {
                this.gl = ensureContext(this.canvas, this.props.webglContextAttributes);
                if (typeof this.props.onContextCreate === 'function') {
                    this.props.onContextCreate(this.gl);
                }
                return this.gl;
            }
            return null;
        }
        async takeSnapshotAsync(options = {}) {
            if (!GLView.takeSnapshotAsync) {
                throw new UnavailabilityError('expo-gl', 'takeSnapshotAsync');
            }
            const gl = this.getGLContextOrReject();
            return await GLView.takeSnapshotAsync(gl, options);
        }
        async startARSessionAsync() {
            throw new UnavailabilityError('GLView', 'startARSessionAsync');
        }
        async createCameraTextureAsync() {
            throw new UnavailabilityError('GLView', 'createCameraTextureAsync');
        }
        async destroyObjectAsync(glObject) {
            throw new UnavailabilityError('GLView', 'destroyObjectAsync');
        }
    }
    GLView.propTypes = propTypes;
    return GLView;
})();
export { GLView };
//# sourceMappingURL=GLView.web.js.map