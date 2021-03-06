import EventEmitter from 'events';
import Annotation from './Annotation';
import AnnotationService from './AnnotationService';
import * as util from './util';
import { ICON_PLACED_ANNOTATION } from './icons/icons';
import {
    STATES,
    TYPES,
    CLASS_ANNOTATION_POINT_MARKER,
    DATA_TYPE_ANNOTATION_INDICATOR,
    THREAD_EVENT,
    CLASS_HIDDEN
} from './constants';

class AnnotationThread extends EventEmitter {
    //--------------------------------------------------------------------------
    // Typedef
    //--------------------------------------------------------------------------

    /**
     * The data object for constructing a thread.
     * @typedef {Object} AnnotationThreadData
     * @property {HTMLElement} annotatedElement HTML element being annotated on
     * @property {Object} [annotations] Annotations in thread - none if
     * this is a new thread
     * @property {AnnotationService} annotationService Annotations CRUD service
     * @property {string} fileVersionId File version ID
     * @property {Object} location Location object
     * @property {string} threadID Thread ID
     * @property {string} thread Thread number
     * @property {string} type Type of thread
     */

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * [constructor]
     *
     * @param {AnnotationThreadData} data - Data for constructing thread
     * @return {AnnotationThread} Annotation thread instance
     */
    constructor(data) {
        super();

        this.annotatedElement = data.annotatedElement;
        this.annotations = data.annotations || {};
        this.annotationService = data.annotationService;
        this.container = data.container;
        this.fileVersionId = data.fileVersionId;
        this.location = data.location;
        this.threadID = data.threadID || AnnotationService.generateID();
        this.threadNumber = data.threadNumber || '';
        this.type = data.type;
        this.locale = data.locale;
        this.isMobile = data.isMobile || false;
        this.hasTouch = data.hasTouch || false;
        this.permissions = data.permissions;
        this.localized = data.localized;
        this.state = STATES.inactive;

        this.regenerateBoundary();

        // Explicitly bind listeners
        this.showDialog = this.showDialog.bind(this);

        this.setup();
    }

    /**
     * [destructor]
     *
     * @return {void}
     */
    destroy() {
        if (this.dialog && !this.isMobile) {
            this.unbindCustomListenersOnDialog();
            this.dialog.destroy();
            this.dialog = null;
        }

        if (this.element) {
            this.unbindDOMListeners();

            if (this.element.parentNode) {
                this.element.parentNode.removeChild(this.element);
            }

            this.element = null;
        }

        if (this.state !== STATES.pending) {
            this.emit(THREAD_EVENT.threadDelete);
        }
    }

    /**
     * Hides the annotation indicator.
     *
     * @return {void}
     */
    hide() {
        util.hideElement(this.element);
    }

    /**
     * Reset state to inactive.
     *
     * @return {void}
     */
    reset() {
        this.state = STATES.inactive;
    }

    /**
     * Whether or not thread dialog is visible
     *
     * @return {void}
     */
    isDialogVisible() {
        return !!(this.dialog && this.dialog.element && !this.dialog.element.classList.contains(CLASS_HIDDEN));
    }

    /**
     * Shows the appropriate annotation dialog for this thread.
     *
     * @return {void}
     */
    showDialog() {
        // Prevents the annotations dialog from being set up on every call
        if (!this.dialog.element) {
            this.dialog.setup(this.annotations, this.element);
        }

        this.dialog.show();
    }

    /**
     * Hides the appropriate annotation dialog for this thread.
     *
     * @return {void}
     */
    hideDialog() {
        if (this.dialog) {
            this.state = STATES.inactive;
            this.dialog.hide();
        }
    }

    /**
     * Saves an annotation.
     *
     * @param {string} type - Type of annotation
     * @param {string} text - Text of annotation to save
     * @return {Promise} - Annotation create promise
     */
    saveAnnotation(type, text) {
        const annotationData = this.createAnnotationData(type, text);

        // Save annotation on client
        const tempAnnotationID = AnnotationService.generateID();
        const tempAnnotationData = annotationData;
        tempAnnotationData.annotationID = tempAnnotationID;
        tempAnnotationData.permissions = {
            can_edit: true,
            can_delete: true
        };
        tempAnnotationData.created = new Date().getTime();
        tempAnnotationData.modified = tempAnnotationData.created;
        const tempAnnotation = new Annotation(tempAnnotationData);
        this.saveAnnotationToThread(tempAnnotation);
        this.state = STATES.inactive;

        if (this.dialog) {
            this.dialog.disable(tempAnnotation.annotationID);
        }

        // Save annotation on server
        return this.annotationService
            .create(annotationData)
            .then((savedAnnotation) => this.updateTemporaryAnnotation(tempAnnotation, savedAnnotation))
            .catch((error) => this.handleThreadSaveError(error, tempAnnotationID));
    }

    /**
     * Deletes an annotation.
     *
     * @param {string} annotationID - ID of annotation to delete
     * @param {boolean} [useServer] - Whether or not to delete on server, default true
     * @return {Promise} - Annotation delete promise
     */
    deleteAnnotation(annotationID, useServer = true) {
        // Ignore if no corresponding annotation exists in thread or user doesn't have permissions
        const annotation = this.annotations[annotationID];
        if (!annotation) {
            // Broadcast error
            this.emit(THREAD_EVENT.deleteError);
            /* eslint-disable no-console */
            console.error(
                THREAD_EVENT.deleteError,
                `Annotation with ID ${annotation.annotationID} could not be found.`
            );
            /* eslint-enable no-console */
            return Promise.reject();
        }

        if (annotation.permissions && !annotation.permissions.can_delete) {
            // Broadcast error
            this.emit(THREAD_EVENT.deleteError);
            /* eslint-disable no-console */
            console.error(
                THREAD_EVENT.deleteError,
                `User does not have the correct permissions to delete annotation with ID ${annotation.annotationID}.`
            );
            /* eslint-enable no-console */
            return Promise.reject();
        }

        // Delete annotation on client
        delete this.annotations[annotationID];

        // If the user doesn't have permission to delete the entire highlight
        // annotation, display the annotation as a plain highlight
        let firstAnnotation = util.getFirstAnnotation(this.annotations);
        let canDeleteAnnotation =
            firstAnnotation && firstAnnotation.permissions && firstAnnotation.permissions.can_delete;
        if (util.isPlainHighlight(this.annotations) && !canDeleteAnnotation) {
            this.cancelFirstComment();

            // If this annotation was the last one in the thread, destroy the thread
        } else if (!firstAnnotation || util.isPlainHighlight(this.annotations)) {
            if (this.isMobile && this.dialog) {
                this.dialog.hideMobileDialog();
                this.dialog.removeAnnotation(annotationID);
            }
            this.destroy();

            // Otherwise, remove deleted annotation from dialog
        } else if (this.dialog) {
            this.dialog.removeAnnotation(annotationID);
            this.showDialog();
            this.dialog.activateReply();
        }

        if (!useServer) {
            /* eslint-disable no-console */
            console.error(
                THREAD_EVENT.deleteError,
                `Annotation with ID ${annotation.threadNumber} not deleted from server`
            );
            /* eslint-enable no-console */
            return Promise.resolve();
        }

        // Delete annotation on server
        return this.annotationService
            .delete(annotationID)
            .then(() => {
                // Ensures that blank highlight comment is also deleted when removing
                // the last comment on a highlight
                firstAnnotation = util.getFirstAnnotation(this.annotations);
                canDeleteAnnotation =
                    firstAnnotation && firstAnnotation.permissions && firstAnnotation.permissions.can_delete;
                if (util.isPlainHighlight(this.annotations) && canDeleteAnnotation) {
                    this.annotationService.delete(firstAnnotation.annotationID);
                }

                // Broadcast thread cleanup if needed
                firstAnnotation = util.getFirstAnnotation(this.annotations);
                if (!firstAnnotation) {
                    this.emit(THREAD_EVENT.threadCleanup);
                }

                // Broadcast annotation deletion event
                this.emit(THREAD_EVENT.delete);
            })
            .catch((error) => {
                // Broadcast error
                this.emit(THREAD_EVENT.deleteError);
                /* eslint-disable no-console */
                console.error(THREAD_EVENT.deleteError, error.toString());
                /* eslint-enable no-console */
            });
    }

    //--------------------------------------------------------------------------
    // Abstract
    //--------------------------------------------------------------------------

    /**
     * Cancels the first comment on the thread
     *
     * @return {void}
     */
    cancelFirstComment() {}

    /**
     * Must be implemented to show the annotation indicator.
     *
     * @return {void}
     */
    show() {}

    /**
     * Must be implemented to create the appropriate annotation dialog and save
     * as a property on the thread.
     *
     * @return {void}
     */
    createDialog() {}

    //--------------------------------------------------------------------------
    // Protected
    //--------------------------------------------------------------------------

    /**
     * Sets up the thread. Creates HTML for annotation indicator, sets
     * appropriate dialog, and binds event listeners.
     *
     * @protected
     * @return {void}
     */
    setup() {
        const firstAnnotation = util.getFirstAnnotation(this.annotations);
        if (!firstAnnotation) {
            this.state = STATES.pending;
        } else {
            this.state = STATES.inactive;
        }

        this.createDialog();
        this.bindCustomListenersOnDialog();

        if (this.dialog) {
            this.dialog.isMobile = this.isMobile;
            this.dialog.localized = this.localized;
        }

        this.setupElement();
    }

    /**
     * Sets up indicator element.
     *
     * @protected
     * @return {void}
     */
    setupElement() {
        this.element = this.createElement();
        this.bindDOMListeners();
    }

    /**
     * Binds DOM event listeners for the thread.
     *
     * @protected
     * @return {void}
     */
    bindDOMListeners() {
        if (!this.element) {
            return;
        }

        this.element.addEventListener('click', this.showDialog);
    }

    /**
     * Unbinds DOM event listeners for the thread.
     *
     * @protected
     * @return {void}
     */
    unbindDOMListeners() {
        if (!this.element) {
            return;
        }

        this.element.removeEventListener('click', this.showDialog);
    }

    /**
     * Binds custom event listeners for the dialog.
     *
     * @protected
     * @return {void}
     */
    bindCustomListenersOnDialog() {
        if (!this.dialog) {
            return;
        }

        // Explicitly bind listeners to the dialog
        this.createAnnotation = this.createAnnotation.bind(this);
        this.cancelUnsavedAnnotation = this.cancelUnsavedAnnotation.bind(this);
        this.deleteAnnotationWithID = this.deleteAnnotationWithID.bind(this);

        this.dialog.addListener('annotationcreate', this.createAnnotation);
        this.dialog.addListener('annotationcancel', this.cancelUnsavedAnnotation);
        this.dialog.addListener('annotationdelete', this.deleteAnnotationWithID);
        this.dialog.addListener('annotationshow', () => this.emit(THREAD_EVENT.show));
        this.dialog.addListener('annotationhide', () => this.emit(THREAD_EVENT.hide));
    }

    /**
     * Unbinds custom event listeners for the dialog.
     *
     * @protected
     * @return {void}
     */
    unbindCustomListenersOnDialog() {
        if (!this.dialog) {
            return;
        }

        this.dialog.removeAllListeners([
            'annotationcreate',
            'annotationcancel',
            'annotationdelete',
            'annotationshow',
            'annotationhide'
        ]);
    }

    /**
     * Destroys mobile and pending/pending-active annotation threads
     *
     * @protected
     * @return {void}
     */
    cancelUnsavedAnnotation() {
        if (!util.isPending(this.state)) {
            this.hideDialog();
            return;
        }

        this.emit(THREAD_EVENT.cancel);
        this.destroy();
    }

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Scroll annotation into the center of the viewport, if possible
     *
     * @private
     * @return {void}
     */
    scrollIntoView() {
        const yPos = parseInt(this.location.y, 10);
        this.scrollToPage();
        this.centerAnnotation(this.annotatedElement.scrollTop + yPos);
    }

    /**
     * Scroll to the annotation's page
     *
     * @private
     * @return {void}
     */
    scrollToPage() {
        // Ignore if annotation does not have a location or page
        if (!this.location || !this.location.page) {
            return;
        }

        const pageEl = this.annotatedElement.querySelector(`[data-page-number="${this.location.page}"]`);
        pageEl.scrollIntoView();
    }

    /**
     * Adjust page scroll position so annotation is centered in viewport
     *
     * @private
     * @param {number} scrollVal - scroll value to adjust so annotation is
     centered in the viewport
     * @return {void}
     */
    centerAnnotation(scrollVal) {
        if (scrollVal < this.annotatedElement.scrollHeight) {
            this.annotatedElement.scrollTop = scrollVal;
        } else {
            this.annotatedElement.scrollTop = this.annotatedElement.scrollBottom;
        }
    }

    /**
     * Update a temporary annotation with the annotation saved on the backend. Set the threadNumber if it has not
     * yet been set. Propogate the threadnumber to an attached dialog if applicable.
     *
     * @private
     * @param {Annotation} tempAnnotation - The locally stored placeholder for the server validated annotation
     * @param {Annotation} savedAnnotation - The annotation determined by the backend to be used as the source of truth
     * @return {void}
     */
    updateTemporaryAnnotation(tempAnnotation, savedAnnotation) {
        if (!(tempAnnotation.annotationID in this.annotations)) {
            // If no temporary annotation is found, save to thread normally
            this.saveAnnotationToThread(savedAnnotation);
        } else {
            // Otherwise, replace temporary annotation with annotation saved to server
            delete this.annotations[tempAnnotation.annotationID];
            this.annotations[savedAnnotation.annotationID] = savedAnnotation;
        }

        // Set threadNumber if the savedAnnotation is the first annotation of the thread
        if (!this.threadNumber && savedAnnotation && savedAnnotation.threadNumber) {
            this.threadNumber = savedAnnotation.threadNumber;
        }

        if (this.dialog) {
            // Add thread number to associated dialog and thread
            if (this.dialog.element && this.dialog.element.dataset) {
                this.dialog.element.dataset.threadNumber = this.threadNumber;
            }

            // Remove temporary annotation and replace it with the saved annotation
            this.dialog.addAnnotation(savedAnnotation);
            this.dialog.removeAnnotation(tempAnnotation.annotationID);
            this.dialog.enable(savedAnnotation.annotationID);
            this.dialog.scrollToLastComment();
        }

        if (this.isMobile) {
            // Changing state from pending
            this.state = STATES.hover;
            this.showDialog();
        }
        this.emit(THREAD_EVENT.save);
    }

    /**
     * Creates the HTML for the annotation indicator.
     *
     * @private
     * @return {HTMLElement} HTML element
     */
    createElement() {
        const indicatorEl = document.createElement('button');
        indicatorEl.classList.add(CLASS_ANNOTATION_POINT_MARKER);
        indicatorEl.setAttribute('data-type', DATA_TYPE_ANNOTATION_INDICATOR);
        indicatorEl.innerHTML = ICON_PLACED_ANNOTATION;
        return indicatorEl;
    }

    /**
     * Saves the provided annotation to the thread and dialog if appropriate
     * and resets state to inactive.
     *
     * @private
     * @param {Annotation} annotation - Annotation to save
     * @return {void}
     */
    saveAnnotationToThread(annotation) {
        this.annotations[annotation.annotationID] = annotation;

        if (this.dialog) {
            this.dialog.addAnnotation(annotation);
            this.dialog.activateReply();
        }
    }

    /**
     * Create an annotation data object to pass to annotation service.
     *
     * @private
     * @param {string} type - Type of annotation
     * @param {string} text - Annotation text
     * @return {Object} Annotation data
     */
    createAnnotationData(type, text) {
        return {
            fileVersionId: this.fileVersionId,
            type,
            text,
            location: this.location,
            user: this.annotationService.user,
            threadID: this.threadID,
            threadNumber: this.threadNumber
        };
    }

    /**
     * Creates a new point annotation
     *
     * @private
     * @param {Object} data - Annotation data
     * @return {void}
     */
    createAnnotation(data) {
        this.saveAnnotation(TYPES.point, data.text);
    }

    /**
     * Deletes annotation with annotationID from thread
     *
     * @private
     * @param {Object} data - Annotation data
     * @return {void}
     */
    deleteAnnotationWithID(data) {
        this.deleteAnnotation(data.annotationID);
    }

    /**
     * Regenerate the coordinates of the rectangular boundary on the saved thread for inserting into the rtree
     *
     * @private
     * @return {void}
     */
    regenerateBoundary() {
        if (!this.location || !this.location.x || !this.location.y) {
            return;
        }

        this.minX = this.location.x;
        this.maxX = this.location.x;
        this.minY = this.location.y;
        this.maxY = this.location.y;
    }

    /**
     * Deletes the temporary annotation if the annotation failed to save on the server
     *
     * @private
     * @param {error} error - error thrown while saving the annotation
     * @param {string} tempAnnotationID - ID of temporary annotation to be updated with annotation from server
     * @return {void}
     */
    handleThreadSaveError(error, tempAnnotationID) {
        // Remove temporary annotation
        this.deleteAnnotation(tempAnnotationID, /* useServer */ false);

        // Broadcast error
        this.emit(THREAD_EVENT.createError);

        /* eslint-disable no-console */
        console.error(THREAD_EVENT.createError, error.toString());
        /* eslint-enable no-console */
    }

    /**
     * Generate threadData with relevant information to be emitted with an
     * annotation thread event
     *
     * @private
     * @return {Object} threadData - Annotation event thread data
     */
    getThreadEventData() {
        const threadData = {
            type: this.type,
            threadID: this.threadID
        };

        if (this.annotationService.user.id > 0) {
            threadData.userId = this.annotationService.user.id;
        }
        if (this.threadNumber) {
            threadData.threadNumber = this.threadNumber;
        }

        return threadData;
    }

    /**
     * Emits a generic viewer event
     *
     * @private
     * @emits viewerevent
     * @param {string} event - Event name
     * @param {Object} eventData - Event data
     * @return {void}
     */
    emit(event, eventData) {
        const threadData = this.getThreadEventData();
        super.emit(event, { data: threadData, eventData });
        super.emit('threadevent', { event, data: threadData, eventData });
    }
}

export default AnnotationThread;
