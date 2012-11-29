define([
        'src/scene',
        'src/interactioncoordinator',
        'src/scenevieweventgenerator',
        'src/selection',
        'src/geometrygraphsingleton',
        'src/asyncAPI',
    ], function(
        sceneModel,
        coordinator,
        sceneViewEventGenerator,
        selection,
        geometryGraph,
        AsyncAPI
    ) {

    // ---------- Common ----------

    var modelForVertex = {};
    
    var keyForVertex = function(vertex) {
        return vertex.editing ? 'editing_' + vertex.id : 'display_' + vertex.id;
    }

    var getModelForVertex = function(vertex) {
        return modelForVertex[keyForVertex(vertex)];
    }

    var cancelIfEditing = function() {
        _.values(modelForVertex).forEach(function(model) {
            if (model.cancel) {
                model.cancel();
            }
        });
    }

    var EventProxy = function() {
        _.extend(this, Backbone.Events);
    }

    var eventProxy = new EventProxy();

    var replaceWithDisplay = function(original, replacement) {
        var modelToDestroy = getModelForVertex(original);
        var rowIndex = modelToDestroy.domView.$el.closest('tr').prevAll().length;
        modelToDestroy.destroy();
        new modelToDestroy.displayModelConstructor({
            vertex: replacement,
            rowIndex: rowIndex,
        });
    }

    var replaceWithEditing = function(original, replacement) {
        var modelToDestroy = getModelForVertex(original);
        var rowIndex = modelToDestroy.domView.$el.closest('tr').prevAll().length;
        modelToDestroy.destroy();
        var newModel = new modelToDestroy.editingModelConstructor({
            original: original, 
            vertex:   replacement,
            rowIndex: rowIndex,
        });
    }

    var replaceOrAppendInTable = function(view, tableSelector) {
        var rowIndex = view.model.attributes.rowIndex;
        if ((rowIndex !== undefined) && 
            (rowIndex < $(tableSelector + ' tr').length)) {
            $($(tableSelector + ' tr')[rowIndex]).before(view.$el);
        } else {
            $(tableSelector).append(view.$el);
        }
    }

    var Model = Backbone.Model.extend({

        initialize: function(options) {
            var vertex = options.vertex;

            // Add/remove must be symmetric
            if (modelForVertex[keyForVertex(vertex)]) {
                throw Error('Already a model for:', vertex.id);
            }

            this.vertex = vertex;
            this.views = [];
            this.selected = selection.isSelected(vertex.id);

            this.vertex.on('descendantChanged', this.descendantChanged, this);
            selection.on('selected', this.select, this);
            selection.on('deselected', this.deselect, this);

            modelForVertex[keyForVertex(vertex)] = this;
        },

        destroy: function() {
            // Add/remove must be symmetric
            if (!modelForVertex[keyForVertex(this.vertex)]) {
                throw Error('No model for:', keyForVertex(this.vertex));
            }

            this.views.forEach(function(view) {
                view.remove();
            });
            this.views = [];

            this.vertex.off('descendantChanged', this.descendantChanged, this);
            selection.off('selected', this.select, this);
            selection.off('deselected', this.deselect, this);

            delete modelForVertex[keyForVertex(this.vertex)];
        },  

        descendantChanged: function(descendant) {
            this.vertex.trigger('change', this.vertex);
        },

        select: function(ids, selection) {
            if (ids.indexOf(this.vertex.id) !== -1) {
                this.selected = true;
                this.trigger('updateSelection', selection);
            }
        },

        deselect: function(ids, selection) {
            if (ids.indexOf(this.vertex.id) !== -1) {
                this.selected = false;
                this.trigger('updateSelection', selection);
            }
        },

    });


    var SceneView = Backbone.View.extend({

        initialize: function() {
            this.scene = sceneModel.view.scene;
            this.rerenderOnCameraChange = false;
            this.cameraScale = new THREE.Vector3(1,1,1);
            this.updateCameraScale(sceneModel.view.camera.position);
            this.render();
            sceneModel.on('cameraChange', this.cameraChanged, this);
        },

        remove: function() {
            this.scene.remove(this.sceneObject);
            sceneViewEventGenerator.deregister(this);
            sceneModel.view.updateScene = true;

            sceneModel.off('cameraChange', this.cameraChanged, this);
        },

        render: function() {
            if (this.sceneObject) {
                this.scene.remove(this.sceneObject);
                sceneViewEventGenerator.deregister(this);
            }
            // Each scene view has two objects, the one that is part of
            // the scene, and an object that is never added to the scene
            // but is only used for selections. E.g. an edge has cylinders 
            // that are used for selection
            this.sceneObject = new THREE.Object3D();
            this.hiddenSelectionObject = new THREE.Object3D();
            this.scene.add(this.sceneObject);

            sceneViewEventGenerator.register(this);
            sceneModel.view.updateScene = true;
        },

        isClickable: function() {
            return false;
        },

        isDraggable: function() {
            return false;
        },

        cameraChanged: function(cameraPosition) {
            if (this.rerenderOnCameraChange && this.updateCameraScale(cameraPosition)) {
                this.render();
            }
        },

        updateCameraScale: function(cameraPosition) {
            var cameraDistance = cameraPosition.length();
            var newScale = cameraDistance/150;
            if (newScale.toFixed(1) !== this.cameraScale.x.toFixed(1)) {
                this.cameraScale = new THREE.Vector3(newScale, newScale, newScale);
                return true;
            } else {
                return false;
            }
        },


    });

    // ---------- Editing ----------

    var EditingModel = Model.extend({

        initialize: function(options) {
            if (!this.displayModelConstructor) {
                throw Error('no Display model constructor set');
            }
            this.originalVertex = options.original;
            Model.prototype.initialize.call(this, options);
            coordinator.on('keyup', this.keyUp, this);
        },

        destroy: function() {
            Model.prototype.destroy.call(this);
            coordinator.off('keyup', this.keyUp, this);

        },

        // Selecting another vertex will cancel the editing
        // of this one
        deselect: function(ids, selection) {
            Model.prototype.deselect.call(this, ids, selection);
            if (ids.indexOf(this.vertex.id) !== -1) {
                this.cancel();
            }
        },

        tryCommit: function() {
            if (this.parentModel) {
                return this.parentModel.tryCommit();
            }

            var that = this;
            if (this.vertex.proto) {
                var uniqueImplicitChildren = _.uniq(geometryGraph.childrenOf(this.vertex).filter(function(v) {
                    return v.implicit;
                })); 

                var originals = [this.vertex].concat(uniqueImplicitChildren.concat());
                AsyncAPI.tryCommitCreate(originals, function(result) {
                    if (!result.error) {
                        var committedVertices = result.newVertices;
                        originals.forEach(function(original, i) {
                            replaceWithDisplay(original, committedVertices[i]);
                        });
                        eventProxy.trigger('committedCreate', originals, committedVertices);
                        selection.deselectAll();

                    }
                });
            } else {
                var originals = [this.originalVertex];
                var editing = [this.vertex];

                if (this.originalImplicitChildren) {
                    originals = originals.concat(this.originalImplicitChildren);
                    editing = editing.concat(this.editingImplicitChildren);
                }

                AsyncAPI.tryCommitEdit(originals, editing, function(result) {
                    if (!result.error) {
                        var committedVertices = result.newVertices;
                        editing.forEach(function(editingVertex, i) {
                            replaceWithDisplay(editingVertex, committedVertices[i]);
                        });
                        eventProxy.trigger('committedEdit', committedVertices);
                        selection.deselectAll();
                    } 
                });
            }
        },

        tryDelete: function() {
            var that = this;
            AsyncAPI.tryCommitDelete(this.vertex, function(result) {
                if (that.editingImplicitChildren) {
                    that.editingImplicitChildren.forEach(function(editingVertex, i) {
                        var modelToDestroy = getModelForVertex(editingVertex);
                        modelToDestroy.destroy();
                    });
                }
                eventProxy.trigger('committedDelete');
                selection.deselectAll();
            });
        },

        cancel: function() {
            if (this.vertex.proto) {

                // IMplicit hildren that aren't shared with other geometry
                var uniqueImplicitChildrenWithOneParent = _.uniq(
                    geometryGraph.childrenOf(this.vertex).filter(function(v) {
                        return v.implicit && (geometryGraph.parentsOf(v).length === 1);
                    }));

                AsyncAPI.cancelCreate(this.vertex);
                uniqueImplicitChildrenWithOneParent.forEach(function(child) {
                    AsyncAPI.cancelCreate(child);
                    getModelForVertex(child).destroy();
                });
                eventProxy.trigger('cancelledCreate');

            } else {
                var originals = [this.originalVertex];
                var editing = [this.vertex];

                if (this.originalImplicitChildren) {
                    originals = originals.concat(this.originalImplicitChildren);
                    editing = editing.concat(this.editingImplicitChildren);
                }

                AsyncAPI.cancelEdit(editing, originals);
                editing.forEach(function(editingVertex, i) {
                    replaceWithDisplay(editingVertex, originals[i]);
                });
                eventProxy.trigger('cancelledEdit');
            }

        },

        keyUp: function(event) {
            if (event.keyCode === 27) {
                this.cancel();
                selection.deselectAll();
            }
        },

    });

    var EditingDOMView = Backbone.View.extend({

        tagName: 'tr',
        className: 'vertex editing',

        initialize: function() {
            this.model.domView = this;
            this.render();
            this.$el.addClass(this.model.vertex.id);
            this.model.vertex.on('change', this.update, this);
        },

        remove: function() {
            Backbone.View.prototype.remove.call(this);
            this.model.vertex.off('change', this.update, this);
        },

        events: {
            'change .field'   : 'fieldChange',
            'keyup .field'    : 'fieldKeyUp',
            'click .delete'   : 'delete',
        },

        fieldChange: function(event) {
            event.stopPropagation();
            if (this.updateFromDOM) {
                this.updateFromDOM();
            }
        },

        fieldKeyUp: function(event) {
            event.stopPropagation();
            // Return
            if (event.keyCode === 13) {
                this.model.tryCommit()
            }
            // Escape
            if (event.keyCode === 27) {
                this.model.cancel();
            } 
        },

        delete: function() {
            if (this.model.vertex.proto) {
                this.model.cancel();
            } else {
                this.model.tryDelete();
            }
        },

    });

    // ---------- Display ----------

    var DisplayModel = Model.extend({

        initialize: function(options) {
            if (!this.displayModelConstructor) {
                throw Error('no Display model constructor set');
            }
            if (!this.editingModelConstructor) {
                throw Error('no Editing model constructor set');
            }
            Model.prototype.initialize.call(this, options);
        },

        replaceDisplayVertex: function(original, replacement) {
            this.destroy();
            new this.displayModelConstructor({vertex: replacement});
        },

        tryDelete: function() {
            AsyncAPI.tryCommitDelete(this.vertex);
        },

    });


    var DisplayDOMView = Backbone.View.extend({

        tagName: "tr",
        className: 'vertex display',

        initialize: function() {
            this.model.domView = this;
            this.render();
            this.$el.addClass(this.model.vertex.name);  
            this.model.on('updateSelection', this.updateSelection, this);
            this.model.vertex.on('change', this.update, this);
        },

        remove: function() {
            Backbone.View.prototype.remove.call(this);
            this.model.off('updateSelection', this.updateSelection, this);
            this.model.vertex.off('change', this.update, this);
        },

    });

    // ---------- Module ----------


    return {
        getModelForVertex      : getModelForVertex,
        cancelIfEditing        : cancelIfEditing,
        eventProxy             : eventProxy,
        replaceWithDisplay     : replaceWithDisplay,
        replaceWithEditing     : replaceWithEditing,
        replaceOrAppendInTable : replaceOrAppendInTable,
        Model                  : Model,
        SceneView              : SceneView,
        EditingModel           : EditingModel,
        EditingDOMView         : EditingDOMView,
        DisplayModel           : DisplayModel,
        DisplayDOMView         : DisplayDOMView
    }

});