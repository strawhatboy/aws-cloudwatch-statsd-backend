var util = require('util');
var AWS = require('aws-sdk');
var _ = require('lodash');

function CloudwatchBackend(startupTime, config, emitter) {
  var self = this;

  this.config = config || {};
  AWS.config = this.config;

  function setEmitter() {
    self.cloudwatch = new AWS.CloudWatch(self.config);
    emitter.on('flush', function(timestamp, metrics) { self.flush(timestamp, metrics); });
  }

  // if iamRole is set attempt to fetch credentials from the Metadata Service
  if (this.config.iamRole) {
    if (this.config.iamRole == 'any') {
      // If the iamRole is set to any, then attempt to fetch any available credentials
      ms = new AWS.EC2MetadataCredentials();
      ms.refresh(function(err) {
        if (err) { console.log('Failed to fetch IAM role credentials: ' + err); }
        self.config.credentials = ms;
        setEmitter();
      });
    } else {
      // however if it's set to specify a role, query it specifically.
      ms = new AWS.MetadataService();
      ms.request('/latest/meta-data/iam/security-credentials/' + this.config.iamRole, function(err, rdata) {
        var data = JSON.parse(rdata);

        if (err) { console.log('Failed to fetch IAM role credentials: ' + err); }
        self.config.credentials = new AWS.Credentials(data.AccessKeyId, data.SecretAccessKey, data.Token);
        setEmitter();
      });
    }
  } else {
    setEmitter();
  }
};

CloudwatchBackend.prototype.processKey = function(key) {
  var parts = key.split(/[\.\/-]/);

  return {
    metricName: parts[parts.length - 1],
    namespace: parts.length > 1 ? parts.splice(0, parts.length - 1).join("/") : null
  };
};

CloudwatchBackend.prototype.isBlacklisted = function(key) {

  var blacklisted = false;

  // First check if key is whitelisted
  if (this.config.whitelist && this.config.whitelist.length > 0 && this.config.whitelist.indexOf(key) >= 0) {
      // console.log("Key (counter) " + key + " is whitelisted");
      return false;
  }

  if (this.config.blacklist && this.config.blacklist.length > 0) {
    for (var i = 0; i < this.config.blacklist.length; i++) {
      if (key.indexOf(this.config.blacklist[i]) >= 0) {
        blacklisted = true;
        break;
      }
    }
  }
  return blacklisted;
};

CloudwatchBackend.prototype.chunk = function(arr, chunkSize) {

  var groups = [],
    i;
  for (i = 0; i < arr.length; i += chunkSize) {
    groups.push(arr.slice(i, i + chunkSize));
  }
  return groups;
};

CloudwatchBackend.prototype.batchSend = function(currentMetricsBatch, namespace) {

  // send off the array (instead of one at a time)
  if (currentMetricsBatch.length > 0) {
    console.log('we got ' + currentMetricsBatch.length + ' data');

    // Chunk into groups of 20
    var chunkedGroups = this.chunk(currentMetricsBatch, 20);

    for (var i = 0, len = chunkedGroups.length; i < len; i++) {
      var metricData = {
        MetricData: chunkedGroups[i],
        Namespace: namespace
      };
      this.cloudwatch.putMetricData(metricData, function(err, data) {
        if (err) {
          // log an error
          console.log(util.inspect(err));
        } else {
          // Success
          // console.log(util.inspect(data));
        }
      });
    }
  }
};

CloudwatchBackend.prototype.flush = function(timestamp, metrics) {

  if (this.config.processKey) {
    this.processKey = this.config.processKeyForDetails;
  }

  console.log('Flushing metrics at ' + new Date(timestamp * 1000).toISOString());

  var counters = metrics.counters;
  var gauges = metrics.gauges;
  var timers = metrics.timers;
  var sets = metrics.sets;

  // put all currently accumulated counter metrics into an array
  var currentCounterMetrics = [];
  var namespace = "AwsCloudWatchStatsdBackend";
  for (key in counters) {
    if (key.indexOf('statsd.') == 0)
      continue;

    if (this.isBlacklisted(key)) {
      continue;
    }

    var names = this.config.processKey ? this.processKey(key) : {};
    if (namespace != names.namespace) {
      // namespace changed, need to send we have now, and clean up
      if (currentCounterMetrics.length > 0) {
        this.batchSend(currentCounterMetrics, namespace);
        currentCounterMetrics = [];
      }
    }
    namespace = this.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
    var metricName = this.config.metricName || names.metricName || key;
    var dimensions = names.dimensions || [];


    _.forEach(this.getDimensionCombinations(dimensions), function(value) {
      currentCounterMetrics.push({
        MetricName: metricName,
        Unit: 'Count',
        Dimensions: value,
        Timestamp: new Date(timestamp * 1000).toISOString(),
        Value: counters[key]
      });
    });
  }

  this.batchSend(currentCounterMetrics, namespace);

  // put all currently accumulated timer metrics into an array
  var currentTimerMetrics = [];
  for (key in timers) {
    if (timers[key].length > 0) {

      if (this.isBlacklisted(key)) {
        continue;
      }

      var values = timers[key].sort(function(a, b) {
        return a - b;
      });
      var count = values.length;
      var min = values[0];
      var max = values[count - 1];

      var cumulativeValues = [min];
      for (var i = 1; i < count; i++) {
        cumulativeValues.push(values[i] + cumulativeValues[i - 1]);
      }

      var sum = min;
      var mean = min;
      var maxAtThreshold = max;

      var message = "";

      var key2;

      sum = cumulativeValues[count - 1];
      mean = sum / count;

      var names = this.config.processKey ? this.processKey(key) : {};
      if (namespace != names.namespace) {
        // namespace changed, need to send we have now, and clean up
        if (currentTimerMetrics.length > 0) {
          this.batchSend(currentTimerMetrics, namespace);
          currentTimerMetrics = [];
        }
      }
      namespace = this.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
      var metricName = this.config.metricName || names.metricName || key;
      var dimensions = names.dimensions || [];

      _.forEach(this.getDimensionCombinations(dimensions), function(value) {
        currentTimerMetrics.push({
          MetricName: metricName,
          Unit: 'Milliseconds',
          Dimensions: value,
          Timestamp: new Date(timestamp * 1000).toISOString(),
          StatisticValues: {
            Minimum: min,
            Maximum: max,
            Sum: sum,
            SampleCount: count
          }
        });
      });
    }
  }

  this.batchSend(currentTimerMetrics, namespace);

  // put all currently accumulated gauge metrics into an array
  var currentGaugeMetrics = [];
  for (key in gauges) {

    if (this.isBlacklisted(key)) {
      continue;
    }

    var names = this.config.processKey ? this.processKey(key) : {};
    if (namespace != names.namespace) {
      // namespace changed, need to send we have now, and clean up
      if (currentGaugeMetrics.length > 0) {
        this.batchSend(currentGaugeMetrics, namespace);
        currentGaugeMetrics = [];
      }
    }
    namespace = this.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
    var metricName = this.config.metricName || names.metricName || key;
    var dimensions = names.dimensions || [];
    var unit = names.unit || 'None';

    _.forEach(this.getDimensionCombinations(dimensions), function(value) {
      currentGaugeMetrics.push({
        MetricName: metricName,
        Unit: unit,
        Dimensions: value,
        Timestamp: new Date(timestamp * 1000).toISOString(),
        Value: gauges[key]
      });
    });
  }

  this.batchSend(currentGaugeMetrics, namespace);

  // put all currently accumulated set metrics into an array
  var currentSetMetrics = [];
  for (key in sets) {

    if (this.isBlacklisted(key)) {
      continue;
    }

    var names = this.config.processKey ? this.processKey(key) : {};
    if (namespace != names.namespace) {
      // namespace changed, need to send we have now, and clean up
      if (currentSetMetrics.length > 0) {
        this.batchSend(currentSetMetrics, namespace);
        currentSetMetrics = [];
      }
    }
    namespace = this.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
    var metricName = this.config.metricName || names.metricName || key;
    var dimensions = names.dimensions || [];
    var unit = names.unit || 'None';

    _.forEach(this.getDimensionCombinations(dimensions), function(value) {
      currentSetMetrics.push({
        MetricName: metricName,
        Unit: unit,
        Dimensions: value,
        Timestamp: new Date(timestamp * 1000).toISOString(),
        Value: sets[key].values().length
      });
    });
  }

  this.batchSend(currentSetMetrics, namespace);
};

CloudwatchBackend.prototype.getDimensionCombinations = function(dimensions) {
  
  var combinations = function(array, startIndex, n) {
    if (n == 0) {
      return [[]];
    }
    if (n == 1) {
      return _.map(array, function(el, index) { return [el] }).filter(function(el, index) { return index >= startIndex });
    }

    if (array.length - startIndex == n) {
      return [_.clone(array).filter(function(el, index) { return index >= startIndex })];
    }

    var result = [];
    if (array.length - startIndex > n) {
      for (var i = startIndex; i <= array.length - n; i++) {
        var combinations_right = combinations(array, i + 1, n - 1);
        for (var j = 0; j < combinations_right.length; j++) {
          result.push([array[i]].concat(combinations_right[j]));
        }
      }
    }

    return result;
  }

  var result = [];
  for (var i = 0; i <= dimensions.length; i++) {
    result = result.concat(combinations(dimensions, 0, dimensions.length - i));
  } 
  return result;
}

exports.init = function(startupTime, config, events) {
  var cloudwatch = config.cloudwatch || {};
  var instances = cloudwatch.instances || [cloudwatch];
  for (key in instances) {
    instanceConfig = instances[key];
    console.log("Starting cloudwatch reporter instance in region:", instanceConfig.region);
    var instance = new CloudwatchBackend(startupTime, instanceConfig, events);
  }
  return true;
};
