//@ sourceURL=Gputop.js
// https://google.github.io/styleguide/javascriptguide.xml

Object.size = function(obj) {
    var size = 0, key;
    for (key in obj) {
        if (obj.hasOwnProperty(key)) size++;
    }
    return size;
};

//------------------------------ Protobuffer Init ----------------------------

if (typeof dcodeIO === 'undefined' || !dcodeIO.ProtoBuf) {
    throw(new Error("ProtoBuf.js is not present. Please see www/index.html for manual setup instructions."));
}
// Initialize ProtoBuf.js
var ProtoBuf = dcodeIO.ProtoBuf;

var proto_builder = ProtoBuf.loadProtoFile("./proto/gputop.proto");

//----------------------------- COUNTER --------------------------------------
function Counter () {
    // Real index number counting with not available ones
    this.idx_ = 0;

    // Index to query inside the C code.
    // -1 Means it is not available or supported
    this.emc_idx_ = -1;
    this.symbol_name = '';
    this.supported_ = false;
    this.xml_ = "<xml/>";

    this.samples_ = 0; // Number of samples processed
    this.data_ = [];
    this.graph_data_ = [];
}

Counter.prototype.append_counter_data = function (start_timestamp, end_timestamp, delta, d_value, max) {
     if (max != 0) {
          //if (this.symbol_name == "SamplersBusy" && this.graph_data_.length > 195)
              //debugger;
        var current_delta = 0;
        var value = 100 * d_value / max;

        if (this.graph_data_.length != 0)
            current_delta = this.graph_data_[this.graph_data_.length - 1][0]; // delta is the last element

        current_delta += delta;

        this.graph_data_.push([current_delta, value]);
        if (this.graph_data_.length > 200) {
            //debugger;
            this.graph_data_.shift();
        }
    }
    this.samples_ ++;
    var n_samples = this.data_.length/3;
    if (n_samples>10)
        return;

    // Do not refresh the counter if there is not a change of data
    if (this.last_value_ == d_value)
        return;

    this.last_value_ = d_value;
    this.invalidate_ = true;

    //if (max != 0)
    //    console.log(" NSamples " + n_samples + " COUNTER ["+start_timestamp+":"+ end_timestamp +"]:"+delta+" = "+ d_value + "/" + max +" Data " + this.symbol_name);

    this.data_.push(delta, d_value, max);

}

//------------------------------ METRIC --------------------------------------
function Metric () {
    // Id for the interface to know on click
    this.name_ = "not loaded";
    this.chipset_ = "not loaded";

    this.set_id_ = 0;
    this.guid_ = "undefined";
    this.xml_ = "<xml/>";
    this.supported_ = false;
    this.emc_counters_ = []; // Array containing only available counters
    this.counters_ = [];     // Array containing all counters
    this.counters_map_ = {}; // Map of counters by with symbol_name
    this.metric_set_ = 0;

    this.oa_query_id_ = -1; // if there is an active query it will be >0

    this.per_ctx_mode_ = false;

    // Real counter number including not available ones
    this.n_total_counters_ = 0;
}

Metric.prototype.is_per_ctx_mode = function() {
    return this.per_ctx_mode_;
}

Metric.prototype.print = function() {
    gputop_ui.weblog(this.guid_);
}

Metric.prototype.find_counter_by_name = function(symbol_name) {
    return this.counters_map_[symbol_name];
}

Metric.prototype.add_new_counter = function(emc_guid, symbol_name, counter) {
    counter.idx_ = this.n_total_counters_++;
    counter.symbol_name = symbol_name;

    var emc_symbol_name = emc_str_copy(symbol_name);
    var counter_idx = _get_counter_id(emc_guid, emc_symbol_name);
    emc_str_free(emc_symbol_name);

    counter.emc_idx_ = counter_idx;
    if (counter_idx != -1) {
        counter.supported_ = true;
        gputop_ui.weblog('Counter ' + counter_idx + " " + symbol_name);
        this.emc_counters_[counter_idx] = counter;
    } else {
        gputop_ui.weblog('Counter not available ' + symbol_name);
    }

    this.counters_map_[symbol_name] = counter;
    this.counters_[counter.idx_] = counter;
}

//------------------------------ GPUTOP --------------------------------------
function Gputop () {
    this.metrics_ = {};     // Map of metrics by INDEX for UI
    this.map_metrics_ = {}; // Map of metrics by GUID

    this.is_connected_ = false;
    // Gputop generic configuration
    this.config_ = {
        url_path: window.location.hostname,
        uri_port: 7890,
        architecture: 'ukn'
    }

    this.get_arch_pretty_name = function() {
        switch (this.config_.architecture) {
            case 'hsw': return "Haswell";
            case 'skl': return "Skylake";
            case 'bdw': return "Broadwell";
            case 'chv': return "Cherryview";
        }
        return this.config_.architecture;
    }

    // Initialize protobuffers
    this.builder_ = proto_builder.build("gputop");

    // Next query ID
    this.query_id_next_ = 1;

    // Current active query sets
    // Indexes by query_id_next_
    this.query_metric_handles_ = [];
    this.query_active_ = undefined;

    // Current metric on display
    this.metric_visible_ = undefined;
}

Gputop.prototype.get_metrics_xml = function() {
    return this.metrics_xml_;
}

// Remember to free this tring
function emc_str_copy(string_to_convert) {
    var buf = Module._malloc(string_to_convert.length+1); // Zero terminated
    stringToAscii(string_to_convert, buf);
    return buf;
}

function emc_str_free(buf) {
    Module._free(buf);
}

var params = [ ];
Gputop.prototype.read_counter_xml = function() {
    var metric = params[0];
    var emc_guid = params[1];

    try {
        var $cnt = $(this);
        var symbol_name = $cnt.attr("symbol_name");

        var counter = new Counter();
        counter.xml_ = $cnt;
        metric.add_new_counter(emc_guid, symbol_name, counter);
    } catch (e) {
        gputop_ui.syslog("Catch parsing counter " + e);
    }
}

Gputop.prototype.get_metric_by_id = function(idx){
    return this.metrics_[idx];
}

Gputop.prototype.get_counter_by_absolute_id = function(metric_set, counter_idx){
    //console.log(" Counter from metric [" + this.metrics_[metric_set].name_ + "]");
    var counter = this.metrics_[metric_set].counters_[counter_idx];
    return counter;
}

Gputop.prototype.get_map_metric = function(guid){
    var metric;
    if (guid in this.map_metrics_) {
        metric = this.map_metrics_[guid];
    } else {
        metric = new Metric();
        metric.guid_ = guid;
        this.map_metrics_[guid] = metric;
    }
    return metric;
}

function gputop_read_metrics_set() {
    try {
        var $set = $(this);
        var guid = $set.attr("guid");

        gputop_ui.weblog('---------------------------------------');

        var metric = gputop.get_map_metric(guid);
        metric.xml_ = $set;
        metric.name_ = $set.attr("name");
        metric.chipset_ = $set.attr("chipset");

        gputop_ui.weblog(guid + '\n Found metric ' + metric.name_);

        // We populate our array with metrics in the same order as the XML
        // The metric will already be defined when the features query finishes
        metric.metric_set_ = Object.keys(gputop.metrics_).length;
        gputop.metrics_[metric.metric_set_] = metric;

        params = [ metric, gputop.get_emc_guid(guid) ];
        $set.find("counter").each(gputop.read_counter_xml, params);
    } catch (e) {
        gputop_ui.syslog("Catch parsing metric " + e);
    }
} // read_metrics_set

Gputop.prototype.query_update_counter = function (counterId, id, start_timestamp, end_timestamp, delta, max, d_value) {
    var metric = this.query_metric_handles_[id];
    if (metric == undefined) {
        //TODO Close this query which is not being captured
        if (counterId == 0)
            gputop_ui.show_alert("No query active for data from "+ id +" ","alert-danger");
        return;
    }

    var counter = metric.emc_counters_[counterId];
    if (counter == null) {
        gputop_ui.show_alert("Counter missing in set "+ metric.name_ +" ","alert-danger");
        return;
    }

    counter.append_counter_data(start_timestamp, end_timestamp, delta, d_value, max);
}

Gputop.prototype.load_xml_metrics = function(xml) {
    gputop.metrics_xml_ = xml;
    $(xml).find("set").each(gputop_read_metrics_set);

    gputop_ui.load_metrics_panel(function() {
        var metric = gputop.get_metric_by_id(0);
        gputop.open_oa_query_for_trace(metric.guid_);
    });
}

Gputop.prototype.load_oa_queries = function(architecture) {
    this.config_.architecture = architecture;
    // read counters from xml file and populate the website
    gputop.xml_file_name_ = "xml/oa-"+ architecture +".xml";
    $.get(gputop.xml_file_name_, this.load_xml_metrics);
}

Gputop.prototype.update_period = function(guid, ms) {
    var metric = this.map_metrics_[guid];
    _gputop_webworker_update_query_period(metric.oa_query_id_, ms);
}

Gputop.prototype.open_oa_query_for_trace = function(guid) {
    if (this.no_supported_metrics_ == true) {
        return;
    }
    
    if (guid == undefined) {
        gputop_ui.show_alert("GUID missing while trying to opening query","alert-danger");
        return;
    }

    var metric = this.get_map_metric(guid);

    // Check if the query is active to not try to open it again
    if (metric.oa_query_id_ != undefined && metric.oa_query_id_ > 0) {
        // Query is already open
        gputop_ui.show_alert("Metric "+guid+" already active","alert-info");
        return;
    }

    // Check if we have to close the old query before opening this one
    if (this.query_active_ != undefined && this.query_active_ != metric) {
        this.close_oa_query(this.query_active_.oa_query_id_, function() {
            console.log("Success! Opening new query "+guid);
            gputop.open_oa_query_for_trace(guid);
        });
        return;
    }

    if (metric.supported_ == false) {
        gputop_ui.show_alert(guid+" "+metric.name_ +" not supported on this kernel","alert-danger");
        return;
    }
    gputop_ui.syslog("Launch query GUID " + guid);

    var oa_query = new this.builder_.OAQueryInfo();
    oa_query.guid = guid;
    oa_query.metric_set = metric.metric_set_;

    /* The timestamp for HSW+ increments every 80ns
     *
     * The period_exponent gives a sampling period as follows:
     *   sample_period = 80ns * 2^(period_exponent + 1)
     *
     * The overflow period for Haswell can be calculated as:
     *
     * 2^32 / (n_eus * max_gen_freq * 2)
     * (E.g. 40 EUs @ 1GHz = ~53ms)
     *
     * We currently sample ~ every 10 milliseconds...
     */

    metric.oa_query_ = oa_query;
    metric.oa_query_id_ = this.query_id_next_++;

    var msg = new this.builder_.Request();
    msg.uuid = this.generate_uuid();

    var open = new this.builder_.OpenQuery();

    oa_query.period_exponent = 14 ;

    open.id = metric.oa_query_id_; // oa_query ID
    open.overwrite = false;   /* don't overwrite old samples */
    open.live_updates = true; /* send live updates */
                         /* nanoseconds of aggregation
				          * i.e. request updates from the worker
				          * as values that have been aggregated
				          * over this duration */

    open.per_ctx_mode = metric.is_per_ctx_mode();
    open.oa_query = oa_query;

    _gputop_webworker_on_open_oa_query(
          metric.oa_query_id_,
          this.get_emc_guid(guid),
          1000000000); //100000000

    msg.open_query = open;
    msg.encode();
    this.socket_.send(msg.toArrayBuffer());

    gputop_ui.syslog("Sent: Request "+msg.uuid);

    this.query_metric_handles_[metric.oa_query_id_] = metric;
    this.query_active_ = metric;

    console.log(" Render animation bars ");
    gputop_ui.show_alert("Opening query "+ metric.name_, "alert-info");
    gputop_ui.render_bars();
}

Gputop.prototype.close_oa_query = function(id, callback) {
    var metric = this.query_metric_handles_[id];
    if (metric == undefined) {
        gputop_ui.show_alert("Cannot close query "+id+", which does not exist ","alert-danger");
        return;
    }

    if (this.query_active_ != undefined && this.query_active_ == metric) {
        this.query_active_ = undefined;
        console.log(" Stop render " + metric.name);
    }
    metric.on_close_callback_ = callback;

    //gputop_ui.show_alert("Closing query "+ metric.name_, "alert-info");

    var msg = new this.builder_.Request();
    msg.uuid = this.generate_uuid();

    _gputop_webworker_on_close_oa_query(metric.oa_query_id_);

    msg.close_query = metric.oa_query_id_;
    msg.encode();
    this.socket_.send(msg.toArrayBuffer());

    gputop_ui.syslog("Sent: Request close query "+msg.uuid);
}

// Moves the guid into the emscripten HEAP and returns a ptr to it
Gputop.prototype.get_emc_guid = function(guid) {
    // Allocate a temporal buffer for the IDs in gputop, we will reuse this buffer.
    // This string will be free on dispose.
    if (gputop.buffer_guid_ == undefined)
        gputop.buffer_guid_ = Module._malloc(guid.length+1); // Zero terminated

    stringToAscii(guid,  gputop.buffer_guid_);
    return gputop.buffer_guid_;
}

Gputop.prototype.get_server_url = function() {
    return this.config_.url_path+':'+this.config_.uri_port;
}

Gputop.prototype.get_websocket_url = function() {
    return 'ws://'+this.get_server_url()+'/gputop/';
}

/* Native compiled Javascript from emscripten to process the counters data */
Gputop.prototype.get_gputop_native_js = function() {
    return 'http://'+this.get_server_url()+'/gputop-web-v2.js';
}

Gputop.prototype.generate_uuid = function()
{
    /* Concise uuid generator from:
     * http://stackoverflow.com/questions/105034/create-guid-uuid-in-javascript
     */
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    	var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
    	return v.toString(16);
    });
}

Gputop.prototype.request_features = function() {
    if (this.socket_.readyState == WebSocket.OPEN) {
        var msg = new this.builder_.Request();

        msg.uuid = this.generate_uuid();
        msg.get_features = true;

        msg.encode();
        this.socket_.send(msg.toArrayBuffer());
        gputop_ui.syslog("Sent: Request "+msg.uuid);
    } else {
        gputop_ui.syslog("Not connected");
    }
}

Gputop.prototype.metric_supported = function(element, index, array){
    var metric = gputop.get_map_metric(element);
    metric.supported_ = true;
    metric.print();
}

Gputop.prototype.process_features = function(features){
    if (features.supported_oa_query_guids.length == 0) {
        gputop.no_supported_metrics_ = true;
        gputop_ui.show_alert("No OA metrics are supported on this Kernel "+features.get_kernel_release(),"alert-danger");
    } else {
        features.supported_oa_query_guids.forEach(this.metric_supported);
    }

    var di = features.devinfo;

    /* We convert the 64 bits protobuffer entry into 32 bits
     * to make it easier to call the emscripten native API.
     * DevInfo values should not overflow the native type,
     * but stay in 64b internally to help native processing in C.
     */
    _update_features(di.devid, di.n_eus.toInt(),  di.n_eu_slices.toInt(),
        di.n_eu_sub_slices.toInt(), di.eu_threads_count.toInt(), di.subslice_mask.toInt(),
        di.slice_mask.toInt());

    gputop_ui.display_features(features);
}

Gputop.prototype.load_emscripten = function() {
    if (gputop.is_connected_)
        return;

    gputop.is_connected_ = true;
    if (gputop.native_js_loaded_ == true) {
        gputop.request_features();
        return;
    }

    $.getScript( gputop.get_gputop_native_js() )
        .done(function( script, textStatus ) {
        gputop.request_features();
        gputop.native_js_loaded_ = true;
    }).fail(function( jqxhr, settings, exception ) {
        console.log( "Failed loading emscripten" );
        setTimeout(function() {
            gputop.connect();
        }, 5000);
    });
}

Gputop.prototype.dispose = function() {
    gputop.metrics_ = {};     // Map of metrics by INDEX for UI
    gputop.map_metrics_ = {}; // Map of metrics by GUID

    gputop.is_connected_ = false;
    gputop.query_id_next_ = 1;

    gputop.query_metric_handles_.forEach(function(metric) {
        // the query stopped being tracked
        metric.oa_query = undefined;
        metric.oa_query_id_ = undefined;
    });

    // Current active query sets
    // Indexes by query_id_next_
    gputop.query_metric_handles_ = [];
    gputop.query_active_ = undefined;
}

Gputop.prototype.get_socket = function(websocket_url) {
    var socket = new WebSocket( websocket_url);
    socket.binaryType = "arraybuffer"; // We are talking binary

    socket.onopen = function() {
        gputop_ui.syslog("Connected");
        gputop_ui.show_alert("Succesfully connected to GPUTOP","alert-success");
        gputop.load_emscripten();
    };

    socket.onclose = function() {
        // Resets the connection
        gputop.dispose();

        gputop_ui.syslog("Disconnected");
        gputop_ui.show_alert("Failed connecting to GPUTOP <p\>Retry in 5 seconds","alert-warning");
        setTimeout(function() { // this will automatically close the alert and remove this if the users doesnt close it in 5 secs
            gputop.connect();
        }, 5000);

        gputop.is_connected_ = false;
    };

    socket.onmessage = function(evt) {
        try {
            var msg_type = new Uint8Array(evt.data, 0);
            var data = new Uint8Array(evt.data, 8);

            switch(msg_type[0]) {
                case 1: /* WS_MESSAGE_PERF */
                    var id = new Uint16Array(evt.data, 4, 1);
                    // Included in webworker
                    //handle_perf_message(id, data);
                break;
                case 2: /* WS_MESSAGE_PROTOBUF */
                    var msg = gputop.builder_.Message.decode(data);
                    if (msg.features != undefined) {
                        gputop_ui.syslog("Features: "+msg.features.get_cpu_model());
                        gputop.process_features(msg.features);
                    } else
                    if (msg.ack != undefined) {
                        gputop_ui.log(0, "Ack");
                    } else
                    if (msg.error != undefined) {
                        gputop_ui.log(4, msg.error);
                        gputop_ui.show_alert(msg.error,"alert-danger");
                    } else
                    if (msg.log != undefined) {
                        var entries = msg.log.entries;
                        entries.forEach(function(entry) {
                            gputop_ui.log(entry.log_level, entry.log_message);
                        });
                    } else
                    if (msg.close_notify != undefined) {
                        var id = msg.close_notify.id;
                        gputop.query_metric_handles_.forEach(function(metric) {
                            if (metric.oa_query_id_ == id) {
                                delete gputop.query_metric_handles_[id];
                                if (metric.on_close_callback_ != undefined) {
                                    metric.on_close_callback_();
                                }

                                // the query stopped being tracked
                                metric.oa_query = undefined;
                                metric.oa_query_id_ = undefined;
                            }
                        });
                    }

                break;
                case 3: /* WS_MESSAGE_I915_PERF */
                    var id = new Uint16Array(evt.data, 4, 1);
                    var dataPtr = Module._malloc(data.length);
                    var dataHeap = new Uint8Array(Module.HEAPU8.buffer, dataPtr, data.length);
                    dataHeap.set(data);
                    _handle_i915_perf_message(id, dataHeap.byteOffset, data.length);
                    Module._free(dataHeap.byteOffset);
                break;
            }
        } catch (err) {
            console.log("Error: "+err);
            log.value += "Error: "+err+"\n";
        }
    };

    return socket;
}

// Connect to the socket for transactions
Gputop.prototype.connect = function() {
    var websocket_url = this.get_websocket_url();
    gputop_ui.syslog('Connecting to port ' + websocket_url);
    //----------------- Data transactions ----------------------
    this.socket_ = this.get_socket(websocket_url);
}

var gputop = new Gputop();
