var sys = require('sys');
var Q = require('q');
var net = require('net');
var http = require('http');
var fs = require('fs');

//得到最新的apnic的信息，里面包含所有的ip和地域相关信息
var getLatestDataDeferred = function () {
//设置ip原始数据的缓存文件名
    var now = new Date();
    var strToday = now.getFullYear() + "" + (now.getMonth() + 1) + now.getDate();
    var fileName = __dirname + '/' + strToday;

    var deferred = Q.defer();
    http.get("http://ftp.apnic.net/apnic/stats/apnic/delegated-apnic-latest", function (res) {
        var buffers = [];
        res.on('data', function (chunk) {
            buffers.push(chunk);
        });
        res.on('end', function () {
            var buffer = Buffer.concat(buffers);
            deferred.resolve(buffer.toString());
        });
    }).on('error', function (err) {
        deferred.reject(err);
    });
    return deferred.promise;
};

// 过滤出中国的ip列表
var pickCNListDeferred = function () {
    //设置ip原始数据的缓存文件名
    var now = new Date();
    var strToday = now.getFullYear() + "" + (now.getMonth() + 1) + now.getDate();
    var fileName = __dirname + '/' + strToday + "-cn";

    var deferred = Q.defer();
    if (fs.existsSync(fileName)) {
        //utf8是个坑，写不需要指定，读必须指定
        fs.readFile(fileName, {encoding: 'utf8'}, function (err, content) {
            if (err) deferred.reject(err);
            deferred.resolve(content);
        });
    }
    else {
        getLatestDataDeferred().then(function (data) {
            var patt = /apnic\|CN\|ipv4\|([\d\.]+)\|(\d+)\|/g;
            var content = '';
            while ((result = patt.exec(data)) != null) {
                content += result[1] + "|" + result[2] + "\r\n";
            }
            fs.writeFile(fileName, content);
            deferred.resolve(content);
        }, function (err) {
            deferred.reject(err);
        });
    }
    return deferred.promise;
};

// 用来查询ip的具体信息，我用来查他的isp，以确定网通电信
// 借鉴简化了 https://github.com/davidcoallier/node-simplewhois
var whoisDeferred = function (domain) {
    var deferred = Q.defer();
    var stream = net.createConnection(43, 'whois.apnic.net');
    var buffers = [];
    stream.addListener('connect', function () {
        stream.write(domain + '\r\n');
    });
    stream.addListener('data', function (data) {
        buffers.push(data);
    });
    stream.addListener('error', function (err) {
        deferred.reject(err);
    });
    stream.addListener('end', function () {
        stream.end();
        var buffer = Buffer.concat(buffers);
        var data = buffer.toString();
        deferred.resolve(data);
    });
    return deferred.promise;
};

// 根据主机数量计算子网掩码，最终目标是构建类似255.255.255.255，计算过程需要一点技巧，基本知识需要自己去补充
// 如果是1个主机掩码是255.255.255.255，翻译成2进制就是1--1(八个一).1--1.1--1.11111111，掩码分为4个小节是为了便于查看和计算
// 当主机数量<=256时，只需要管最后一个小节即可，例如：
// 如果是2个主机，掩码最后一个小节是11111110(254)。加上前面的三节就是1--1.1--1.1--1.11111110
// 如果是4个主机，掩码最后一个小节是11111100(252)。1--1.1--1.1--1.11111100
// 可以看到就是256-主机数量
// 当主机数量<=65536(256*256)时，需要管后两个小节，例如：
// 如果是512个主机，掩码最后一个小节是11111110.00000000(254.0)(4294966784=),。加上前面的两节就是1--1.1--1.11111110.0--0
// 如果是1024个主机，掩码最后一个小节是252.0,就是11111100.00000000
// 可以看到就是65536-主机数量
// 规律就是：设主机个数为n，掩码的数值则等于：总数量-(n-1)。四个节点总主机个数等于256*256*256*256
// 得到掩码对应的数值之后，通过转换为2进制，然后按照8位截取，再将8位的2进制数转为10进制数，拼接
var count2MaskStr = function (cn) {
    var maxMask = 4294967296;
    var result = maxMask - cn;
//    console.log(result);
    var str = result.toString(2);
//    console.log(str);
    var strMaskList = str.match(/(\d{8})/g);
//    console.log(strMaskList);
    var strResult = '';
    strMaskList.forEach(function (str) {
        strResult += "." + parseInt(str, 2).toString(10);
    })
    return strResult.substr(1);
};

//"dx;118.184.176.13;255.255.255.255;WAN1;1\r\n"
//构建电信网段的信息
var generateDxRouteItemDeferred = function (ip, cn) {
    var deferred = Q.defer();
    whoisDeferred(ip).then(function (data) {
        //目前是取铁通和电信，这里的正则可以再补充完善
        if (/[ChinaTelecom|CHINANET]/.test(data)) {
            var resultStr = "dx:" + ip + "：" + count2MaskStr(cn) + ";WAN1;1\r\n";
            deferred.resolve(resultStr);
        }
        else
            deferred.resolve();
    }, function (err) {
        deferred.reject(err);
    });
    return deferred.promise;
};

//generateDxRouteItemDeferred('180.149.128.0', 8192).then(function (data) {
//    console.log(data);
//}, function (err) {
//    console.log(err);
//});

//基于递归实现的
//var generateDxRouteItemDeferred1By1 = function (ipAndCnList, result) {
//    var icStr = ipAndCnList.pop();
//    if (icStr.trim() == '')
//        generateDxRouteItemDeferred1By1(ipAndCnList, result);
//
//    var ic = icStr.split("|");
//    var deferred = Q.defer();
//    console.log(ic[0]);
//    generateDxRouteItemDeferred(ic[0], ic[1]).then(function (icResult) {
//        result += icResult;
//        if (ipAndCnList.length == 0)
//            deferred.resolve(ipAndCnList, result);
//        else
//            generateDxRouteItemDeferred1By1(ipAndCnList, result);
//    }, function (err) {
//        //deferred.reject(err);
//        console.log(ic);
//        ipAndCnList.push(icStr);
//        generateDxRouteItemDeferred1By1(ipAndCnList, result);
//    });
//    return deferred.promise;
//};


//基于promise递归尝试
var generateDxRouteItemDeferred1By1 = function (ipAndCnList, result) {
    var icStr = ipAndCnList.pop();
    if (icStr.trim() == '')
        generateDxRouteItemDeferred1By1(ipAndCnList, result);

    var ic = icStr.split("|");
    var deferred = Q.defer();
    console.log(ic[0]);
    generateDxRouteItemDeferred(ic[0], ic[1]).then(function (icResult) {
        result += icResult;
        if (ipAndCnList.length == 0)
            deferred.resolve(ipAndCnList, result);
        else
            generateDxRouteItemDeferred1By1(ipAndCnList, result);
    }, function (err) {
        //deferred.reject(err);
        console.log(ic);
        ipAndCnList.push(icStr);
        generateDxRouteItemDeferred1By1(ipAndCnList, result);
    });
    return deferred.promise;
};


var defaultRouteList = "dianxin-pubdns;118.184.176.13;255.255.255.255;WAN1;1\r\n" +
    "lt-dnspod;183.60.52.217;255.255.255.255;WAN2;1\r\n" +
    "lt-dnspod;183.60.62.80;255.255.255.255;WAN2;1\r\n";

pickCNListDeferred()
    .then(function (content) {
        var dxRouteContent = defaultRouteList.trim();
        var ipAndCnList = content.split("\r\n");
        var len = ipAndCnList.length;

// 放弃这种写法，四千多次网络请求会导致大量网络超时
//        var promises = [];
//        var idx = 0
//        for (; idx <= len - 1; idx++) {
//            console.log(idx);
//            if (ipAndCnList[idx].trim() == "")
//                continue;
//            var ic = ipAndCnList[idx].split("|");
//            var promise = generateDxRouteItemDeferred(ic[0], ic[1]);
//            promises.push(promise);
//        }
//        Q.allSettled(promises)
//            .then(function (results) {
//                results.forEach(function (result) {
//                    if (result.state == 'fulfilled' && result.value)
//                        dxRouteContent += result.value;
//                    else if (result.state == 'rejected')
//                        console.log(result.reason);
//                })
//                console.log(dxRouteContent);
//            }).done();

        //这个方法也会因为网络不稳定有问题，暂时可以先用
        generateDxRouteItemDeferred1By1(ipAndCnList, defaultRouteList).then(function (ipAndCnList, content) {
            var fileName = __dirname + '/dxRoute';
            fs.writeFile(fileName, content);
        }, function (err) {
            console.log(err);
        });
    });