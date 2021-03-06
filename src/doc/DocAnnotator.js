import rangy from 'rangy';
/* eslint-disable no-unused-vars */
// Workaround for rangy npm issue: https://github.com/timdown/rangy/lib/issues/342
import rangyClassApplier from 'rangy/lib/rangy-classapplier';
import rangyHighlight from 'rangy/lib/rangy-highlighter';
import rangySaveRestore from 'rangy/lib/rangy-selectionsaverestore';
/* eslint-enable no-unused-vars */
import Annotator from '../Annotator';
import DocHighlightThread from './DocHighlightThread';
import DocPointThread from './DocPointThread';
import DocDrawingThread from './DocDrawingThread';
import CreateHighlightDialog from './CreateHighlightDialog';
import * as util from '../util';
import * as docUtil from './docUtil';
import {
    STATES,
    TYPES,
    DATA_TYPE_ANNOTATION_INDICATOR,
    PAGE_PADDING_TOP,
    PAGE_PADDING_BOTTOM,
    CLASS_ANNOTATION_LAYER_HIGHLIGHT,
    CLASS_ANNOTATION_LAYER_HIGHLIGHT_COMMENT,
    CLASS_ANNOTATION_LAYER_DRAW,
    CLASS_ANNOTATION_PLAIN_HIGHLIGHT,
    THREAD_EVENT,
    ANNOTATOR_EVENT,
    CONTROLLER_EVENT,
    CREATE_EVENT
} from '../constants';

const SELECTION_TIMEOUT = 500;
const CLASS_RANGY_HIGHLIGHT = 'rangy-highlight';

const SELECTOR_PREVIEW_DOC = '.bp-doc';
const CLASS_DEFAULT_CURSOR = 'bp-use-default-cursor';

// Required by rangy highlighter
const ID_ANNOTATED_ELEMENT = 'ba-rangy-annotated-element';

const ANNOTATION_LAYER_CLASSES = [
    CLASS_ANNOTATION_LAYER_HIGHLIGHT,
    CLASS_ANNOTATION_LAYER_HIGHLIGHT_COMMENT,
    CLASS_ANNOTATION_LAYER_DRAW
];

class DocAnnotator extends Annotator {
    /** @property {CreateHighlightDialog} - UI used to create new highlight annotations. */
    createHighlightDialog;

    /** @property {Event} - For delaying creation of highlight quad points and dialog. Tracks the
     * current selection event, made in a previous event. */
    lastHighlightEvent;

    /** @property {Selection} - For tracking diffs in text selection, for mobile highlights creation. */
    lastSelection;

    /** @property {boolean} - True if regular highlights are allowed to be read/written */
    plainHighlightEnabled;

    /** @property {boolean} - True if draw annotations are allowed to be read/written */
    drawEnabled;

    /** @property {boolean} - True if comment highlights are allowed to be read/written */
    commentHighlightEnabled;

    /** @property {Function} - Reference to filter function that has been bound TODO(@jholdstock): remove on refactor. */
    showFirstDialogFilter;

    /**
     * [destructor]
     *
     * @return {void}
     */
    destroy() {
        super.destroy();
        if (!this.createHighlightDialog) {
            return;
        }

        if (this.commentHighlightEnabled) {
            this.createHighlightDialog.removeListener(CREATE_EVENT.comment, this.highlightCurrentSelection);
            this.createHighlightDialog.removeListener(CREATE_EVENT.post, this.createHighlightThread);
        }

        if (this.plainHighlightEnabled) {
            this.createHighlightDialog.removeListener(CREATE_EVENT.plain, this.createPlainHighlight);
        }

        this.createHighlightDialog.destroy();
        this.createHighlightDialog = null;
    }

    /** @inheritdoc */
    init(initialScale) {
        super.init(initialScale);

        // Allow rangy to highlight this
        this.annotatedElement.id = ID_ANNOTATED_ELEMENT;
    }

    //--------------------------------------------------------------------------
    // Abstract Implementations
    //--------------------------------------------------------------------------

    /**
     * Determines the annotated element in the viewer
     *
     * @param {HTMLElement} containerEl Container element for the viewer
     * @return {HTMLElement} Annotated element in the viewer
     */
    getAnnotatedEl(containerEl) {
        return containerEl.querySelector(SELECTOR_PREVIEW_DOC);
    }

    /**
     * Returns an annotation location on a document from the DOM event or null
     * if no correct annotation location can be inferred from the event. For
     * point annotations, we return the (x, y) coordinates and page the
     * point is on in PDF units with the lower left corner of the document as
     * the origin. For highlight annotations, we return the PDF quad points
     * as defined by the PDF spec and page the highlight is on.
     *
     * @override
     * @param {Event} event DOM event
     * @param {string} annotationType Type of annotation
     * @return {Object|null} Location object
     */
    getLocationFromEvent(event, annotationType) {
        let location = null;
        const zoomScale = util.getScale(this.annotatedElement);

        if (annotationType === TYPES.point) {
            let clientEvent = event;
            if (this.hasTouch && event.targetTouches) {
                if (event.targetTouches.length <= 0) {
                    return location;
                }
                clientEvent = event.targetTouches[0];
            }

            // If click isn't on a page, ignore
            const eventTarget = clientEvent.target;
            const pageInfo = util.getPageInfo(eventTarget);
            const pageEl = pageInfo.pageEl
                ? pageInfo.pageEl
                : this.annotatedElement.querySelector(`[data-page-number="${pageInfo.page}"]`);
            if (!pageEl) {
                return location;
            }

            // If there is a selection, ignore
            if (docUtil.isSelectionPresent()) {
                return location;
            }

            // If click is inside an annotation dialog, ignore
            const dataType = util.findClosestDataType(eventTarget);
            if (util.isInDialog(event) || dataType === DATA_TYPE_ANNOTATION_INDICATOR) {
                return location;
            }

            // Store coordinates at 100% scale in PDF space in PDF units
            const pageDimensions = pageEl.getBoundingClientRect();
            const pageWidth = pageDimensions.width;
            const pageHeight = pageDimensions.height - PAGE_PADDING_TOP - PAGE_PADDING_BOTTOM;
            const browserCoordinates = [
                clientEvent.clientX - pageDimensions.left,
                clientEvent.clientY - pageDimensions.top - PAGE_PADDING_TOP
            ];

            // If click is outside the page, ignore
            if (docUtil.isCoordOutside(browserCoordinates, pageWidth, pageHeight)) {
                return location;
            }

            let [x, y] = browserCoordinates;
            // Do not create annotation if event doesn't have coordinates
            if (Number.isNaN(x) || Number.isNaN(y)) {
                this.emit(ANNOTATOR_EVENT.error, this.localized.createError);
                return location;
            }

            const pdfCoordinates = docUtil.convertDOMSpaceToPDFSpace(browserCoordinates, pageHeight, zoomScale);
            [x, y] = pdfCoordinates;

            // We save the dimensions of the annotated element scaled to 100%
            // so we can compare to the annotated element during render time
            // and scale if needed (in case the representation changes size)
            const dimensions = {
                x: pageWidth / zoomScale,
                y: pageHeight / zoomScale
            };

            location = { x, y, page: pageInfo.page, dimensions };
        } else if (util.isHighlightAnnotation(annotationType)) {
            if (!this.highlighter || !this.highlighter.highlights.length) {
                return location;
            }

            // Get correct page
            let { pageEl, page } = util.getPageInfo(window.getSelection().anchorNode);
            if (!pageEl) {
                // The ( .. ) around assignment is required syntax
                ({ pageEl, page } = util.getPageInfo(this.annotatedElement.querySelector(`.${CLASS_RANGY_HIGHLIGHT}`)));
            }

            // Use highlight module to calculate quad points
            const { highlightEls } = docUtil.getHighlightAndHighlightEls(this.highlighter, pageEl);

            // Do not create highlight annotation if no highlights are detected
            if (highlightEls.length === 0) {
                return location;
            }

            const quadPoints = [];
            highlightEls.forEach((element) => {
                quadPoints.push(docUtil.getQuadPoints(element, pageEl, zoomScale));
            });

            // We save the dimensions of the annotated element scaled to 100%
            // so we can compare to the annotated element during render time
            // and scale if needed (in case the representation changes size)
            const pageDimensions = pageEl.getBoundingClientRect();
            const pageWidth = pageDimensions.width;
            const pageHeight = pageDimensions.height - PAGE_PADDING_TOP - PAGE_PADDING_BOTTOM;
            const dimensions = {
                x: pageWidth / zoomScale,
                y: pageHeight / zoomScale
            };

            location = { page, quadPoints, dimensions };
        }

        return location;
    }

    /**
     * Creates the proper type of thread, adds it to in-memory map, and returns it.
     *
     * @override
     * @param {Object} annotations Annotations in thread
     * @param {Object} location Location object
     * @param {string} [type] Optional annotation type
     * @return {AnnotationThread} Created annotation thread
     */
    createAnnotationThread(annotations, location, type) {
        let thread;
        const threadParams = this.getThreadParams(annotations, location, type);
        if (!util.areThreadParamsValid(threadParams)) {
            this.handleValidationError();
            return thread;
        }

        if (util.isHighlightAnnotation(type)) {
            thread = new DocHighlightThread(threadParams, this.commentHighlightEnabled);
        } else if (type === TYPES.draw) {
            thread = new DocDrawingThread(threadParams);
        } else if (type === TYPES.point) {
            thread = new DocPointThread(threadParams);
        }

        if (!thread) {
            this.emit(ANNOTATOR_EVENT.error, this.localized.loadError);
        }

        return thread;
    }

    /**
     * Override to factor in highlight types being filtered out, if disabled. Also scales annotation canvases.
     *
     * @override
     * @param {number} pageNum Page number
     * @return {void}
     */
    renderPage(pageNum) {
        // Scale existing canvases on re-render
        this.scaleAnnotationCanvases(pageNum);
        super.renderPage(pageNum);

        if (this.createHighlightDialog && this.createHighlightDialog.isVisible) {
            this.createHighlightDialog.hide();
        }
    }

    /**
     * Scales all annotation canvases for a specified page.
     *
     * @override
     * @param {number} pageNum Page number
     * @return {void}
     */
    scaleAnnotationCanvases(pageNum) {
        const pageEl = this.annotatedElement.querySelector(`[data-page-number="${pageNum}"]`);

        ANNOTATION_LAYER_CLASSES.forEach((annotationLayerClass) => {
            const annotationLayerEl = pageEl.querySelector(`canvas.${annotationLayerClass}`);
            if (annotationLayerEl) {
                docUtil.scaleCanvas(pageEl, annotationLayerEl);
            }
        });
    }

    //--------------------------------------------------------------------------
    // Protected
    //--------------------------------------------------------------------------

    /**
     * Annotations setup.
     *
     * @protected
     * @override
     * @return {void}
     */
    setupAnnotations() {
        // Determine enabled annotation types before binding mode controller listeners
        this.plainHighlightEnabled = !!this.modeControllers[TYPES.highlight];
        this.commentHighlightEnabled = !!this.modeControllers[TYPES.highlight_comment];
        this.drawEnabled = !!this.modeControllers[TYPES.draw];

        // Don't bind to draw specific handlers if we cannot draw
        if (this.drawEnabled) {
            this.drawingSelectionHandler = this.drawingSelectionHandler.bind(this);
        }

        // Don't bind to highlight specific handlers if we cannot highlight
        if (!this.plainHighlightEnabled && !this.commentHighlightEnabled) {
            super.setupAnnotations();
            return;
        }

        // Explicit scoping
        this.highlightCreateHandler = this.highlightCreateHandler.bind(this);
        this.highlightMouseupHandler = this.highlightMouseupHandler.bind(this);
        this.highlightMousedownHandler = this.highlightMousedownHandler.bind(this);
        this.hideCreateDialog = this.hideCreateDialog.bind(this);

        this.clickThread = this.clickThread.bind(this);

        if (this.isMobile || this.hasTouch) {
            this.onSelectionChange = this.onSelectionChange.bind(this);
        }

        this.createHighlightDialog = new CreateHighlightDialog(this.container, {
            isMobile: this.isMobile,
            hasTouch: this.hasTouch,
            allowComment: this.commentHighlightEnabled,
            allowHighlight: this.plainHighlightEnabled,
            localized: this.localized
        });

        this.createHighlightDialog.addListener(CREATE_EVENT.init, () =>
            this.emit(THREAD_EVENT.pending, TYPES.highlight)
        );

        if (this.commentHighlightEnabled) {
            this.highlightCurrentSelection = this.highlightCurrentSelection.bind(this);
            this.createHighlightDialog.addListener(CREATE_EVENT.comment, this.highlightCurrentSelection);

            this.createHighlightThread = this.createHighlightThread.bind(this);
            this.createHighlightDialog.addListener(CREATE_EVENT.post, this.createHighlightThread);
        }

        if (this.plainHighlightEnabled) {
            this.createPlainHighlight = this.createPlainHighlight.bind(this);
            this.createHighlightDialog.addListener(CREATE_EVENT.plain, this.createPlainHighlight);
        }

        // Init rangy and rangy highlight
        this.highlighter = rangy.createHighlighter();
        this.highlighter.addClassApplier(
            rangy.createClassApplier(CLASS_RANGY_HIGHLIGHT, {
                ignoreWhiteSpace: true,
                tagNames: ['span', 'a']
            })
        );

        super.setupAnnotations();
    }

    /**
     * Binds DOM event listeners.
     *
     * @protected
     * @override
     * @return {void}
     */
    bindDOMListeners() {
        super.bindDOMListeners();

        // Highlight listeners on desktop & mobile
        if (this.plainHighlightEnabled || this.commentHighlightEnabled) {
            this.annotatedElement.addEventListener('mouseup', this.highlightMouseupHandler);
            this.annotatedElement.addEventListener('wheel', this.hideCreateDialog);

            if (this.hasTouch) {
                this.annotatedElement.addEventListener('touchend', this.hideCreateDialog);
            }
        }

        if (this.hasTouch && this.drawEnabled) {
            this.annotatedElement.addEventListener('touchstart', this.drawingSelectionHandler);
        } else if (this.drawEnabled) {
            this.annotatedElement.addEventListener('click', this.drawingSelectionHandler);
        }

        // Prevent highlight creation if annotating (or plain AND comment highlights) is disabled
        if (!this.permissions.canAnnotate || !(this.plainHighlightEnabled || this.commentHighlightEnabled)) {
            return;
        }

        if (this.hasTouch || this.isMobile) {
            document.addEventListener('selectionchange', this.onSelectionChange);
        } else {
            this.annotatedElement.addEventListener('dblclick', this.highlightMouseupHandler);
            this.annotatedElement.addEventListener('mousedown', this.highlightMousedownHandler);
            this.annotatedElement.addEventListener('contextmenu', this.highlightMousedownHandler);
        }
    }

    /**
     * Unbinds DOM event listeners.
     *
     * @protected
     * @override
     * @return {void}
     */
    unbindDOMListeners() {
        super.unbindDOMListeners();

        this.annotatedElement.removeEventListener('mouseup', this.highlightMouseupHandler);
        this.annotatedElement.removeEventListener('wheel', this.hideCreateDialog);
        this.annotatedElement.removeEventListener('touchend', this.hideCreateDialog);

        if (this.highlightThrottleHandle) {
            cancelAnimationFrame(this.highlightThrottleHandle);
            this.highlightThrottleHandle = null;
        }

        Object.keys(this.modeControllers).forEach((mode) => {
            const controller = this.modeControllers[mode];
            controller.removeSelection();
        });

        if (this.hasTouch || this.isMobile) {
            document.removeEventListener('selectionchange', this.onSelectionChange);
        } else {
            this.annotatedElement.removeEventListener('click', this.drawingSelectionHandler);
            this.annotatedElement.removeEventListener('dblclick', this.highlightMouseupHandler);
            this.annotatedElement.removeEventListener('mousedown', this.highlightMousedownHandler);
            this.annotatedElement.removeEventListener('contextmenu', this.highlightMousedownHandler);
        }
    }

    /**
     * Hides and resets the shared mobile dialog.
     *
     * @return {void}
     */
    removeThreadFromSharedDialog() {
        if (!this.mobileDialogEl) {
            return;
        }

        this.mobileDialogEl.classList.remove(CLASS_ANNOTATION_PLAIN_HIGHLIGHT);
        super.removeThreadFromSharedDialog();
    }

    hideCreateDialog(event) {
        const isCreateDialogVisible = this.createHighlightDialog && this.createHighlightDialog.isVisible;
        if (!isCreateDialogVisible || !event || util.isInDialog(event)) {
            return;
        }

        this.createHighlightDialog.hide();
    }

    /**
     * Clears the text selection and hides the create highlight dialog
     *
     * @param {Event} event - Mouse wheel event
     * @return {void}
     */
    resetHighlightSelection(event) {
        this.isCreatingHighlight = false;
        this.hideCreateDialog(event);
        document.getSelection().removeAllRanges();
    }

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Creates a plain highlight annotation.
     *
     * @private
     * @return {void}
     */
    createPlainHighlight() {
        this.highlightCurrentSelection();
        this.createHighlightThread();
    }

    /**
     * Creates an highlight annotation thread, adds it to in-memory map, and returns it.
     *
     * @private
     * @param {string} [commentText] If provided, this will save a highlight comment annotation, with commentText
     * being the text as the first comment in the thread.
     * @return {DocHighlightThread} Created doc highlight annotation thread
     */
    createHighlightThread(commentText) {
        // Empty string will be passed in if no text submitted in comment
        if (commentText === '' || !this.lastHighlightEvent) {
            return null;
        }

        const isCreateDialogVisible = this.createHighlightDialog && this.createHighlightDialog.isVisible;
        if (isCreateDialogVisible) {
            this.createHighlightDialog.hide();
        }

        this.isCreatingHighlight = false;

        const highlightType = commentText ? TYPES.highlight_comment : TYPES.highlight;
        const location = this.getLocationFromEvent(this.lastHighlightEvent, highlightType);
        this.highlighter.removeAllHighlights();
        if (!location) {
            return null;
        }

        const annotations = {};
        const thread = this.createAnnotationThread(annotations, location, highlightType);
        this.lastHighlightEvent = null;
        this.lastSelection = null;

        if (!thread) {
            return null;
        }

        if (!commentText) {
            thread.dialog.drawAnnotation();
        } else {
            thread.dialog.hasComments = true;
        }

        thread.state = STATES.hover;
        thread.show();
        thread.dialog.postAnnotation(commentText);

        const controller = this.modeControllers[highlightType];
        if (controller) {
            controller.registerThread(thread);
        }

        this.emit(THREAD_EVENT.threadSave, thread.getThreadEventData());
        return thread;
    }

    /**
     * Handles changes in text selection. Used for mobile highlight creation.
     *
     * @private
     * @param {Event} event The DOM event coming from interacting with the element.
     * @return {void}
     */
    onSelectionChange(event) {
        event.preventDefault();
        event.stopPropagation();

        if (this.selectionEndTimeout) {
            clearTimeout(this.selectionEndTimeout);
            this.selectionEndTimeout = null;
        }

        // Do nothing if in a text area or mobile dialog or mobile create dialog is already open
        const pointController = this.modeControllers[TYPES.point];
        const isCreatingPoint = !!(pointController && pointController.pendingThreadID);
        if (isCreatingPoint || document.activeElement.nodeName.toLowerCase() === 'textarea') {
            return;
        }

        const selection = window.getSelection();

        // If we're creating a new selection, make sure to clear out to avoid
        // incorrect text being selected
        if (!this.lastSelection || !selection || !docUtil.hasSelectionChanged(selection, this.lastSelection)) {
            this.highlighter.removeAllHighlights();
        }

        // Bail if mid highlight and tapping on the screen
        if (!docUtil.isValidSelection(selection)) {
            this.lastHighlightEvent = null;
            this.createHighlightDialog.hide();
            this.highlighter.removeAllHighlights();
            return;
        }

        this.selectionEndTimeout = setTimeout(() => {
            if (this.createHighlightDialog) {
                this.createHighlightDialog.show(this.container, selection);
            }
        }, SELECTION_TIMEOUT);

        const { page } = util.getPageInfo(event.target);

        // Set all annotations on current page that are in the 'hover' state to 'inactive'
        if (this.plainHighlightEnabled) {
            this.modeControllers[TYPES.highlight].applyActionToThreads((thread) => thread.reset(), page);
        }

        if (this.commentHighlightEnabled) {
            this.modeControllers[TYPES.highlight_comment].applyActionToThreads((thread) => thread.reset(), page);
        }

        this.lastSelection = selection;
        this.lastHighlightEvent = event;
    }

    /**
     * Highlight the current range of text that has been selected.
     *
     * @private
     * @return {void}
     */
    highlightCurrentSelection() {
        if (!this.highlighter) {
            return;
        }

        this.highlighter.highlightSelection('rangy-highlight', {
            containerElementId: this.annotatedElement.id
        });
    }

    /**
     * Mousedown handler on annotated element. Also delegates to mousedown
     * handler for each thread.
     *
     * @private
     * @param {Event} event DOM event
     * @return {void}
     */
    highlightMousedownHandler(event) {
        this.isCreatingHighlight = true;
        this.mouseX = event.clientX;
        this.mouseY = event.clientY;

        if (this.plainHighlightEnabled) {
            this.modeControllers[TYPES.highlight].applyActionToThreads((thread) => thread.onMousedown());
        }

        if (this.commentHighlightEnabled) {
            this.modeControllers[TYPES.highlight_comment].applyActionToThreads((thread) => thread.onMousedown());
        }
    }

    /**
     * Drawing selection handler. Delegates to the drawing controller
     *
     * @private
     * @param {Event} event DOM event
     * @return {void}
     */
    drawingSelectionHandler(event) {
        const controller = this.modeControllers[TYPES.draw];
        if (controller && !this.isCreatingAnnotation() && !this.isCreatingHighlight) {
            controller.handleSelection(event);
        }
    }

    /**
     * Returns whether any mode controller is currently creating an
     * annotation thread
     *
     * @private
     * @return {boolean} Whether any controller has a pending thread
     */
    isCreatingAnnotation() {
        let isPending = false;
        Object.keys(this.modeControllers).some((mode) => {
            const controller = this.modeControllers[mode];
            if (controller.hadPendingThreads) {
                isPending = true;
            }
            return isPending;
        });
        return isPending;
    }

    /**
     * Mouseup handler. Switches between creating a highlight and delegating
     * to highlight click handlers depending on whether mouse moved since
     * mousedown.
     *
     * @private
     * @param {Event} event DOM event
     * @return {void}
     */
    highlightMouseupHandler(event) {
        if (this.highlighter) {
            this.highlighter.removeAllHighlights();
        }

        const hasMouseMoved =
            (this.mouseX && this.mouseX !== event.clientX) || (this.mouseY && this.mouseY !== event.clientY);

        // Creating highlights is disabled on mobile for now since the
        // event we would listen to, selectionchange, fires continuously and
        // is unreliable. If the mouse moved or we double clicked text,
        // we trigger the create handler instead of the click handler
        if ((this.createHighlightDialog && hasMouseMoved) || event.type === 'dblclick') {
            this.highlightCreateHandler(event);
        } else {
            this.highlightClickHandler(event);
        }
    }

    /**
     * Handler for creating a pending highlight thread from the current
     * selection. Default creates highlight threads as ANNOTATION_TYPE_HIGHLIGHT.
     * If the user adds a comment, the type changes to
     * ANNOTATION_TYPE_HIGHLIGHT_COMMENT.
     *
     * @private
     * @param {Event} event DOM event
     * @return {void}
     */
    highlightCreateHandler(event) {
        event.stopPropagation();

        const selection = window.getSelection();
        if (!docUtil.isValidSelection(selection)) {
            return;
        }

        // Select page of first node selected
        const { pageEl } = util.getPageInfo(selection.anchorNode);
        if (!pageEl) {
            return;
        }

        const dialogParentEl = this.isMobile ? this.container : pageEl;
        this.createHighlightDialog.show(dialogParentEl, selection);

        this.isCreatingHighlight = true;
        this.lastHighlightEvent = event;
    }

    /**
     * Highlight click handler. Delegates click event to click handlers for
     * threads on the page.
     *
     * @private
     * @param {Event} event DOM event
     * @return {void}
     */
    highlightClickHandler(event) {
        this.activeThread = null;
        this.mouseEvent = event;
        this.consumed = false;

        let plainThreads = [];
        let commentThreads = [];

        if (this.plainHighlightEnabled) {
            plainThreads = this.modeControllers[TYPES.highlight].getIntersectingThreads(this.mouseEvent);
        }

        if (this.commentHighlightEnabled) {
            commentThreads = this.modeControllers[TYPES.highlight_comment].getIntersectingThreads(this.mouseEvent);
        }

        this.hideAnnotations(event);

        const intersectingThreads = [].concat(plainThreads, commentThreads);
        intersectingThreads.forEach(this.clickThread);

        // Show active thread last
        if (this.activeThread) {
            this.activeThread.show();
        } else if (this.isMobile) {
            this.removeThreadFromSharedDialog();
        } else {
            this.resetHighlightSelection(event);
        }
    }

    /**
     * Delegates click event to click handlers for threads on the page.
     *
     * @private
     * @param {AnnotationThread} thread Highlight thread to check
     * @return {void}
     */
    clickThread(thread) {
        if (util.isPending(thread.state)) {
            // Destroy any pending highlights on click outside the highlight
            if (thread.type === TYPES.point) {
                thread.destroy();
            } else {
                thread.cancelFirstComment();
            }
        } else if (util.isHighlightAnnotation(thread.type)) {
            // We use this to prevent a mousedown from activating two different
            // highlights at the same time - this tracks whether a delegated
            // mousedown activated some highlight, and then informs the other
            // keydown handlers to not activate
            const threadActive = thread.onClick(this.mouseEvent, this.consumed);
            if (threadActive) {
                this.activeThread = thread;
            }

            this.consumed = this.consumed || threadActive;
        } else {
            thread.hideDialog();
        }
    }

    /**
     * Show normal cursor instead of text cursor.
     *
     * @private
     * @return {void}
     */
    useDefaultCursor() {
        this.annotatedElement.classList.add(CLASS_DEFAULT_CURSOR);
    }

    /**
     * Use text cursor.
     *
     * @private
     * @return {void}
     */
    removeDefaultCursor() {
        this.annotatedElement.classList.remove(CLASS_DEFAULT_CURSOR);
    }

    /**
     * Helper to remove a Rangy highlight by deleting the highlight in the
     * internal highlighter list that has a matching ID. We can't directly use
     * the highlighter's removeHighlights since the highlight could possibly
     * not be a true Rangy highlight object.
     *
     * @private
     * @param {Object} highlight Highlight to delete.
     * @return {void}
     */
    removeRangyHighlight(highlight) {
        const { highlights } = this.highlighter;
        if (!Array.isArray(highlights)) {
            return;
        }

        const matchingHighlights = highlights.filter((internalHighlight) => {
            return internalHighlight.id === highlight.id;
        });

        this.highlighter.removeHighlights(matchingHighlights);
    }

    /**
     * Handle events emitted by the annotaiton service
     *
     * @private
     * @param {Object} [data] Annotation service event data
     * @param {string} [data.event] Annotation service event
     * @param {string} [data.data] Annotation event data
     * @return {void}
     */
    handleControllerEvents(data) {
        switch (data.event) {
            case CONTROLLER_EVENT.toggleMode:
                this.resetHighlightSelection(data.event);
                break;
            case CONTROLLER_EVENT.bindDOMListeners:
                this.hideCreateDialog(data);
                break;
            case CONTROLLER_EVENT.renderPage:
                this.renderPage(data.data);
                break;
            default:
        }
        super.handleControllerEvents(data);
    }

    /**
     * For filtering out and only showing the first thread in a list of threads.
     *
     * @private
     * @param {Object} thread The annotation thread to either hide or show
     * @param {number} index The index of the annotation thread
     * @return {void}
     */
    showFirstDialogFilter(thread, index) {
        if (index === 0) {
            thread.show();
        } else {
            thread.hideDialog();
        }
    }
}

export default DocAnnotator;
