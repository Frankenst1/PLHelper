// ==UserScript==
// @name         PLHelper
// @description  Makes downloading PL torrents easier, as well as having some more clarity on some pages.
// @namespace    http://tampermonkey.net/
// @version      0.4.3
// @author       Frankenst1
// @match        https://pornolab.net/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pornolab.net
// @updateURL    https://raw.githubusercontent.com/Frankenst1/PLHelper/main/PLHelper.js
// @downloadURL  https://raw.githubusercontent.com/Frankenst1/PLHelper/main/PLHelper.js
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    // TODO: ability to change settings (ability to set preferences (video quality, tags, ...)).
    // TODO: add proper debugging.
    // TODO: add ability to start downloading the torrents as well?
    const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const TORRENT_STORAGE_KEY = 'downloadedTorrents';
    const PROFILE_PREFERENCES_KEY = 'profile_preferences';
    const SERVER_TIMEZONE = 'Europe/Moscow';

    // TODO: move these constants to a "profile settings" page.
    const PREFERRED_VIDEO_FORMATS = ["1080", "720", "4K", "2160"];
    const SKIP_DOWNLOADED = true;
    const URL_DELAY = 1000;

    // CSS region
    GM_addStyle('.lds-ripple { display: inline-block; position: relative; width: 80px; height: 80px; } .lds-ripple div { position: absolute; border: 4px solid #000; opacity: 1; border-radius: 50%; animation: lds-ripple 1s cubic-bezier(0, 0.2, 0.8, 1) infinite; } .lds-ripple div:nth-child(2) { animation-delay: -0.5s; } @keyframes lds-ripple { 0% { top: 36px; left: 36px; width: 0; height: 0; opacity: 0; } 4.9% { top: 36px; left: 36px; width: 0; height: 0; opacity: 0; } 5% { top: 36px; left: 36px; width: 0; height: 0; opacity: 1; } 100% { top: 0px; left: 0px; width: 72px; height: 72px; opacity: 0; } }');
    GM_addStyle('.progress-bar-container { color: #000 !important; background-color: darkgrey !important; } .progress-bar { color: #fff !important; background-color: #607d8b !important; text-align: center; } .progress-bar::after, .progress-bar::before { content: ""; display: table; clear: both; } .progress-bar * { min-width: 60px; display: inline-block; }');

    // Classes region
    class Torrent {
        constructor(id, title, pageUrl, size, topic, downloadDate = null) {
            this.id = id;
            this.title = title;
            this.pageUrl = pageUrl;
            this.size = size;
            this.downloadDate = downloadDate;
            this.topic = topic;
        }
    }

    class TorrentTopic {
        constructor(id, title, pageUrl = null) {
            this.id = id;
            this.title = title;
            this.pageUrl = pageUrl ? pageUrl : `./forum/tracker.php?f=${id}`;
        }
    }

    class ProfilePreferences {
        constructor(hideDownloadedTorrents) {
            this.hideDownloadedTorrents = hideDownloadedTorrents;
        }
    }

    // Helper function region
    function convertSizeBetweenUnits(value, fromUnit, toUnit) {
        const fromIndex = SIZE_UNITS.indexOf(fromUnit);
        const toIndex = SIZE_UNITS.indexOf(toUnit);

        if (fromIndex === -1 || toIndex === -1) {
            throw new Error('Invalid unit provided');
        }

        const bytes = value * Math.pow(1024, fromIndex);
        const convertedValue = bytes / Math.pow(1024, toIndex);

        return Number(convertedValue.toFixed(2));
    }

    function formatBytes(value) {
        let unitIndex = 0;

        while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
            value /= 1024;
            unitIndex++;
        }

        const formattedValue = Number(value.toFixed(2));
        const unit = SIZE_UNITS[unitIndex];

        return `${formattedValue} ${unit}`;
    }

    function getIdFromUrl(url, type) {
        let id = null;
        switch (type) {
            case 'topic':
                id = url.split('?f=').pop();
                break;
            case 'torrent':
                id = url.split('?t=').pop();
                break;
            default:
                id = false;
                break;
        }

        if (id === url) {
            console.debug(`Invalid URL (${url}) for type (${type}).`);
            return false;
        }

        return id;
    }

    function getTorrentStats(){
        var sizeRegex = /^([\d.,]+)\s*([a-zA-Z]+)/;

        // Help class to easily fetch the data we care about.
        function getSizeValue(element, index) {
            const content = element?.textContent.match(sizeRegex);
            if (content) {
                const bytes = convertSizeBetweenUnits(content[1], content[2], 'B');
                return bytes;
            }
            return 0;
        }

        const rows = document.querySelectorAll('.ratio tr');
        const elements = [
            { index: 1 },
            { index: 2, id: '#u_up_total' },
            { index: 3, id: '#u_up_release' },
            { index: 4, id: '#u_up_bonus' }
        ];

        let totalDown = 0;
        let totalUp = 0;
        let totalRelease = 0;
        let totalBonus = 0;

        for (const element of elements) {
            const row = rows[element.index];
            const updateValue = getSizeValue(row.querySelector('td:nth-of-type(1)'), element.index);
            const todayValue = getSizeValue(row.querySelector('td:nth-of-type(2)'), element.index);
            const totalValue = getSizeValue(row.querySelector('td:nth-of-type(4)'), element.index);

            switch (element.index) {
                case 1:
                    totalDown = updateValue + todayValue + totalValue;
                    break;
                case 2:
                    totalUp = updateValue + todayValue + totalValue;
                    break;
                case 3:
                    totalRelease = updateValue + todayValue + totalValue;
                    break;
                case 4:
                    totalBonus = updateValue + todayValue + totalValue;
                    break
                default:
                    console.debug('Unmapped index found.');
            }
        }

        return {
            'totalUp': totalUp,
            'totalRelease': totalRelease,
            'totalBonus': totalBonus,
            'totalDown': totalDown,
        };
    }

    function predictRatio() {
        const stats = getTorrentStats();
        const rating = stats.totalDown !== 0 ? (stats.totalUp + stats.totalRelease + stats.totalBonus) / stats.totalDown : 0;

        return Math.floor(rating * 100) / 100;
    }

    function getNearestRatio(ratio) {
        const ratios = [1, 0.5, 0.3];
        let nearestRatio = 0;

        for (let i = 0; i < ratios.length; i++) {
            if (ratio < ratios[i]) {
                nearestRatio = ratios[i];
            } else if (ratio === ratios[i]) {
                nearestRatio = ratios[i - 1] || ratios[i];
            } else {
                break;
            }
        }

        return nearestRatio;
    }

    function calculateRequiredUploadRatio(down, up, ratio) {
        const currentRatio = up / down;

        if (currentRatio >= ratio) {
            return 0;
        }

        const requiredUpload = ratio * down - up;
        return requiredUpload;
    }

    function markDownloadedTorrents() {
        const torrentRows = document.querySelectorAll('#tor-tbl tr.tCenter');

        torrentRows.forEach((row) => {
            const torrentLinkEl = row.querySelector('td:nth-of-type(4) a');
            const torrentLink = torrentLinkEl?.href;
            const torrentId = getIdFromUrl(torrentLink, 'torrent');
            if (isTorrentAlreadyDownloaded(torrentId)) {
                torrentLinkEl?.setAttribute('style', 'color:green;');
            }
        });
    }

    function resetTorrentsMarkedAsDownloaded() {
        GM_setValue(TORRENT_STORAGE_KEY, []);
    }

    function isTorrentAlreadyDownloaded(torrentId) {
        const downloadedTorrents = getAllDownloadedTorrents();
        return downloadedTorrents.some((obj) => obj.id == torrentId);
    }

    function getTorrentDownloadLink(torrent) {
        return `dl.php?t=${torrent.id}`;
    }

    function getTorrentPage(torrent) {
        return `./viewtopic.php?t=${torrent.id}`;
    }

    function countDownloadedToday() {
        const downloadedTorrents = getAllDownloadedTorrents();
        const today = new Date();
        const todayItems = downloadedTorrents.filter(torrent => {
            const torrentDate = new Date(torrent.downloadDate);
            return torrentDate.getDate() === today.getDate() &&
                torrentDate.getMonth() === today.getMonth() &&
                torrentDate.getFullYear() === today.getFullYear();
        });

        return todayItems.length;
    }

    function calculateDownloadLimit(gbUploaded, gbDownloaded, ratio) {
        if (ratio >= 1.0) {
            if (gbUploaded >= 100) {
                return 100;
            } else {
                return 50;
            }
        } else if (ratio >= 0.5) {
            return 50;
        } else if (ratio >= 0.3) {
            return 10;
        } else if (gbDownloaded < 2) {
            return 5;
        } else {
            return 0;
        }
    }

    function calculateRemainingDownloadQuota() {
        const nDownloaded = countDownloadedToday();

        return getDownloadQuotaForProfile() - nDownloaded;
    }

    function getDownloadQuotaForProfile() {
        // TODO: fetch/store this data from GM_setValue() with profile data. This allows us to call this method from non-profile pages as well (maybe show on tracker overview).
        const currentRatio = document.querySelector('#u_ratio b.gen')?.innerText;
        let downTotal = document.querySelector("#u_down_total span")?.innerHTML.split("&nbsp;");
        let upTotal = document.querySelector("#u_up_total span")?.innerHTML.split("&nbsp;");
        downTotal = convertSizeBetweenUnits(downTotal[0], downTotal[1], "GB");
        upTotal = convertSizeBetweenUnits(upTotal[0], upTotal[1], "GB");

        return calculateDownloadLimit(upTotal, downTotal, currentRatio);
    }

    // Returns "true" if on the correct page.
    function checkPage(page) {
        let cp = location.pathname;
        switch (page) {
            case 'profile_page':
                return cp.includes('profile.php') && document.getElementById('passkey-val');
            case 'tracker_page':
                return cp.includes('tracker.php');
            case 'torrent_page':
                return cp.includes('viewtopic.php') && location.search.includes('?t=') && document.querySelector('.dl-link') !== null;
            default:
                return false;
        }
    }

    // TODO: rework (see getAllDownloadLinksWithString) Or better yet, re use it to fetch based on torrentType after altering / extending the functionality).
    function getAllPicturePacks() {
        const torrentRows = document.querySelectorAll('#tor-tbl tr.tCenter');
        const matchedTorrents = { Pictures: [] };

        torrentRows.forEach((row) => {
            const torrentType = row.querySelector('td:nth-of-type(1) a').innerText;

            if (torrentType.includes('Picture')) {
                const torrentId = row.querySelector('td:nth-of-type(4) a').getAttribute('href').replace('./', '').replace('viewtopic.php?t=', '');
                const torrentTitle = row.querySelector('td:nth-of-type(4) a').innerText;
                const pageUrl = new URL(row.querySelector('td:nth-of-type(4) a').getAttribute('href'), document.baseURI).href;
                const torrentSize = row.querySelector('td:nth-of-type(6) a').innerText;

                const torrent = new Torrent(torrentId, torrentTitle, pageUrl, torrentSize);
                matchedTorrents['Pictures'].push(torrent);
            }
        });

        return matchedTorrents;
    }

    function getAllDownloadLinksWithString(searchStrings = []) {
        const torrentRows = document.querySelectorAll('#tor-tbl tr.tCenter');
        const downloadedtorrents = getAllDownloadedTorrents();

        const filteredTorrentsByString = {};

        searchStrings.forEach(searchString => {
            const filteredTorrentRows = Array.from(torrentRows).filter(row => row.textContent.includes(searchString));

            const filteredTorrents = filteredTorrentRows.map(row => {
                const topicElement = row.querySelector('td:nth-of-type(3)');
                const topicUrl = topicElement.querySelector('a')?.href;
                const topicId = getIdFromUrl(topicUrl, 'topic');
                const topicTitle = topicElement.textContent?.trim();
                const topic = new TorrentTopic(topicId, topicTitle, topicUrl);

                const subjectElement = row.querySelector('td:nth-of-type(4)');
                const subject = subjectElement.textContent?.trim();
                const url = subjectElement.querySelector('a')?.href;
                const size = row.querySelector('td:nth-of-type(6)').textContent?.trim();
                const id = url.split('?t=').pop();

                const torrent = new Torrent(id, subject, url, size, topic);

                const hideDownloadedTorrents = getProfilePreferences()?.hideDownloadedTorrents ?? false;
                const isAlreadyDownloaded = isTorrentAlreadyDownloaded(id);

                if (!isAlreadyDownloaded && !hideDownloadedTorrents) {
                    return torrent;
                }
            }).filter((value) => value !== undefined);

            filteredTorrentsByString[searchString] = filteredTorrents;
        });

        return filteredTorrentsByString;
    }

    function getAllDownloadedTorrents() {
        return GM_getValue(TORRENT_STORAGE_KEY, []);
    }

    function getProfilePreferences() {
        let preferences = GM_getValue(PROFILE_PREFERENCES_KEY);

        if (!preferences) {
            console.debug("No preferences found. Creating new ones.");
            preferences = new ProfilePreferences();
            setProfilePreferences(preferences);
        }

        return preferences;
    }

    function setProfilePreferences(profilePreferences) {
        GM_setValue(PROFILE_PREFERENCES_KEY, profilePreferences);
    }

    function resetAllData() {
        const confirmReset = confirm("Reset all to default settings? This cannot be undone.");
        if (confirmReset) {
            GM_deleteValue(TORRENT_STORAGE_KEY);
            GM_deleteValue(PROFILE_PREFERENCES_KEY);
            location.reload();
        }
    }

    function getTimeUntilMidnightMSK() {
        const mskOffset = getMSKOffset();
        const now = Date.now();
        const currentTimeMSK = new Date(now + mskOffset);

        const midnightMSK = new Date(currentTimeMSK);
        midnightMSK.setUTCHours(21, 0, 0, 0); // 21 corresponds to 00:00 MSK because MSK is UTC+3

        const timeDifference = midnightMSK - currentTimeMSK;

        const hours = Math.floor(timeDifference / (1000 * 60 * 60));
        const minutes = Math.floor((timeDifference % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeDifference % (1000 * 60)) / 1000);

        return `${hours} hours, ${minutes} minutes, ${seconds} seconds`;
    }

    // Function to update the time to reset display
    function updateTimeToResetDisplay() {
        const timeToReset = getTimeUntilMidnightMSK();
        const timeToResetElement = document.getElementById('time-to-update');
        timeToResetElement.textContent = `Time until quota update: ${timeToReset}`;
    }

    function updateFreeleechInfo(){
        const leechInfoElement = document.getElementById('freeleech-countdown');
        leechInfoElement.innerText = getFreeleechInfo();
    }

    function getNextFreeleechDate() {
        const mskOffset = getMSKOffset();

        // Get the current date in MSK timezone
        const currentDate = new Date(Date.now() + mskOffset * 60 * 1000);

        // Get the current year and month
        const currentYear = currentDate.getUTCFullYear();
        const currentMonth = currentDate.getUTCMonth();

        // Calculate the last day of the current month
        const lastDayOfMonth = new Date(currentYear, currentMonth + 1, 0).getUTCDate();

        // Find the last Saturday of the month
        let freeleechDate;
        for (let day = lastDayOfMonth; day > 0; day--) {
            const dayDate = new Date(currentYear, currentMonth, day);
            if (dayDate.getUTCDay() === 6) { // Saturday
                freeleechDate = dayDate;
                break;
            }
        }

        // Set the time to the start of the day
        freeleechDate.setUTCHours(0, 0, 0, 0);

        // Adjust for MSK timezone offset
        freeleechDate.setUTCMinutes(freeleechDate.getUTCMinutes() - mskOffset);

        return freeleechDate;
    }

    function getMSKOffset() {
        const mskTimeZone = SERVER_TIMEZONE;
        const date = new Date();
        const options = { timeZone: mskTimeZone };
        return date.getTimezoneOffset() * -1; // Convert to positive
    }

    // Function to display information about the freeleech event
    function getFreeleechInfo() {
        const now = new Date();
        const mskOffset = getMSKOffset(); // MSK timezone offset in hours
        const nextEventStart = getNextFreeleechDate();
        const eventStart = new Date(nextEventStart);

        console.log(nextEventStart);
        console.log(eventStart);

        eventStart.setUTCHours(eventStart.getUTCHours() + mskOffset);
        const eventEnd = new Date(eventStart);
        eventEnd.setUTCDate(eventEnd.getUTCDate() + 1);
        const timeUntilEvent = nextEventStart - now;

        let freeleechInfo = '';
        if (now < eventStart) {
            const daysUntilEvent = Math.floor(timeUntilEvent / (1000 * 60 * 60 * 24));
            const hoursUntilEvent = Math.floor((timeUntilEvent % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutesUntilEvent = Math.floor((timeUntilEvent % (1000 * 60 * 60)) / (1000 * 60));
            const secondsUntilEvent = Math.floor((timeUntilEvent % (1000 * 60)) / 1000);

            freeleechInfo = `Next freeleech event: (${daysUntilEvent}d ${hoursUntilEvent}h ${minutesUntilEvent}m ${secondsUntilEvent}s).`;
        } else if (now < eventEnd) {
            const eventDuration = eventEnd - eventStart;
            const timeLeft = eventEnd - now;
            const hoursLeft = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutesLeft = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
            const secondsLeft = Math.floor((timeLeft % (1000 * 60)) / 1000);

            freeleechInfo = `FREELEECH NOW!!! Time remaining: ${hoursLeft}h, ${minutesLeft}m, ${secondsLeft}s.)`;
            console.log(`The freeleech event is currently running.`);
            console.log(`Time remaining: ${hoursLeft} hours, ${minutesLeft} minutes, ${secondsLeft} seconds.`);
        } else {
            console.log(`The last freeleech event has ended.`);
        }

        return freeleechInfo;
    }

    // DOM creation section
    function generateTorrentsTable(torrents) {
        // Create the table element
        const table = document.createElement('table');
        table.className = 'forumline tablesorter';
        table.id = 'tor-tbl';

        // Create the table header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        // Create the "Forum" column header
        const forumHeader = document.createElement('th');
        forumHeader.className = 'header';
        forumHeader.width = '25%';
        forumHeader.innerHTML = '<b class="tbs-text"><font style="vertical-align: inherit;"><font style="vertical-align: inherit;">Forum</font></font></b><span class="tbs-icon">&nbsp;&nbsp;</span>';
        headerRow.appendChild(forumHeader);

        // Create the "Subject" column header
        const subjectHeader = document.createElement('th');
        subjectHeader.className = 'header';
        subjectHeader.width = '75%';
        subjectHeader.innerHTML = '<b class="tbs-text"><font style="vertical-align: inherit;"><font style="vertical-align: inherit;">Subject</font></font></b><span class="tbs-icon">&nbsp;&nbsp;</span>';
        headerRow.appendChild(subjectHeader);

        // Create the "Size" column header
        const sizeHeader = document.createElement('th');
        sizeHeader.className = 'header';
        sizeHeader.innerHTML = '<b class="tbs-text"><font style="vertical-align: inherit;"><font style="vertical-align: inherit;">Size</font></font></b><span class="tbs-icon">&nbsp;&nbsp;</span>';
        headerRow.appendChild(sizeHeader);

        // Create the "Added" column header
        const addedHeader = document.createElement('th');
        addedHeader.className = 'header';
        addedHeader.innerHTML = '<b class="tbs-text"><font style="vertical-align: inherit;"><font style="vertical-align: inherit;">Added</font></font></b><span class="tbs-icon">&nbsp;&nbsp;</span>';
        headerRow.appendChild(addedHeader);

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Create the table body
        const tbody = document.createElement('tbody');

        // Iterate over the data and generate table rows
        torrents.forEach((item) => {
            const row = document.createElement('tr');
            row.className = 'tCenter';

            const forumColumn = document.createElement('td');
            forumColumn.className = 'row1';
            const forumLink = document.createElement('a');
            forumLink.className = 'gen f';
            const forumId = item.topic?.id;
            forumLink.href = `https://pornolab.net/forum/tracker.php?f=${forumId}`;
            forumLink.innerText = item.topic?.title ? item.topic?.title : 'N/A';
            forumColumn.appendChild(forumLink);
            row.appendChild(forumColumn);

            const subjectColumn = document.createElement('td');
            subjectColumn.className = 'row4 med tLeft u';
            const subjectLink = document.createElement('a');
            subjectLink.className = 'med tLink bold';
            subjectLink.href = getTorrentPage(item);
            subjectLink.innerHTML = item.title;
            subjectColumn.appendChild(subjectLink);
            row.appendChild(subjectColumn);

            const sizeColumn = document.createElement('td');
            sizeColumn.className = 'row4 small nowrap';
            const sizeLink = document.createElement('a');
            sizeLink.className = 'small tr-dl dl-stub';
            sizeLink.href = getTorrentDownloadLink(item);
            sizeLink.innerText = item.size;
            sizeColumn.appendChild(sizeLink);
            row.appendChild(sizeColumn);

            const addedColumn = document.createElement('td');
            addedColumn.className = 'row4 small nowrap';
            const addedText = document.createElement('p');
            addedText.innerText = 'N/A';
            if (typeof item.downloadDate === 'string' || item.downloadDate instanceof String) {
                addedText.innerText = item.downloadDate;
            }
            addedColumn.appendChild(addedText);
            row.appendChild(addedColumn);

            tbody.appendChild(row);
        });

        table.appendChild(tbody);

        // Create the table footer
        const tfoot = document.createElement('tfoot');
        const footerRow = document.createElement('tr');
        const footerColumn = document.createElement('td');
        footerColumn.className = 'catBottom';
        footerColumn.colSpan = '100%';
        footerRow.appendChild(footerColumn);
        tfoot.appendChild(footerRow);
        table.appendChild(tfoot);

        return table;
    }

    function generateArrayOfDownloadButtons(torrents) {
        const downloadButtons = [];

        // TODO: move to different method!
        Object.keys(torrents).forEach((key) => {
            const filter = key;
            const length = torrents[filter].length;
            const eta = new Date(Date.now() + (length * URL_DELAY)).toLocaleString();
            const dwndBtnCallback = (e) => {
                e.preventDefault();

                console.debug(`Start opening tabs (ETA: ${eta})`);
                const matches = torrents[filter];
                matches.forEach((torrent, index) => {
                    setTimeout(() => {
                        const percentage = Math.floor((index + 1) / length * 100);
                        console.debug(`Downloading ${index + 1}/${length} (${percentage}%) - ${torrent.pageUrl}`);
                        GM_openInTab(torrent.pageUrl);

                        const torrentLink = document.querySelector(`a[href="./viewtopic.php?t=${torrent.id}"]`);
                        torrentLink.style.textDecoration = 'line-through';

                        updateProgressBar('torrent-open-tab-progress-bar', percentage);

                    }, index * URL_DELAY);
                });
            };

            downloadButtons.push(generateButton('bold clickable', `Download ${length} items (${filter}).`, dwndBtnCallback));
        });

        return downloadButtons;
    }

    function generateLoadingDiv(torrent) {
        // Create the outer div element with class "lds-ring"
        const outerDiv = document.createElement('div');
        outerDiv.classList.add('lds-ripple');

        // Create the four inner div elements
        for (let i = 0; i < 2; i++) {
            const innerDiv = document.createElement('div');
            outerDiv.appendChild(innerDiv);
        }

        // Add the created element to the document body (or any other desired parent element)
        document.body.appendChild(outerDiv);

        return outerDiv;
    }

    function generateProgressBar(percentage, id, helperText = null) {
        // Create the outer container div
        var containerDiv = document.createElement('div');
        containerDiv.className = 'progress-bar-container';
        containerDiv.id = id;

        // Create the inner progress bar div
        var progressBarDiv = document.createElement('div');
        progressBarDiv.className = 'progress-bar';
        progressBarDiv.style.width = `${percentage}%`;
        const text = helperText ? `${percentage}% (${helperText})` : `${percentage}%`;
        progressBarDiv.textContent = text;

        // Append the inner progress bar div to the outer container div
        containerDiv.appendChild(progressBarDiv);

        return containerDiv;
    }

    function generateLegend(legendText, htmlContent = null) {
        const tdElement = document.createElement('td');

        const fieldsetElement = document.createElement('fieldset');
        fieldsetElement.style.marginTop = '14px';
        fieldsetElement.style.paddingBottom = '4px';

        const legendElement = document.createElement('legend');
        const legendTextElement = document.createElement('font');
        legendTextElement.style.verticalAlign = 'inherit';
        legendTextElement.textContent = legendText;
        legendElement.appendChild(legendTextElement);

        const divElement = document.createElement('div');
        divElement.className = 'tCenter';
        divElement.innerHTML = htmlContent;

        fieldsetElement.appendChild(legendElement);
        fieldsetElement.appendChild(divElement);

        tdElement.appendChild(fieldsetElement);

        return tdElement;
    }

    function generateButton(btnClasses, btnText, callback) {
        const button = document.createElement('input');
        const btnType = 'submit';

        button.className = btnClasses;
        button.value = btnText;
        button.type = btnType;
        button.style.width = '200px';
        button.style.marginTop = '26px';
        button.style.marginBottom = '10px';
        button.addEventListener('click', callback);

        return button;
    }

    function generateToggle(labelText, initialValue, callback) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        const span = document.createElement("span");

        input.type = "checkbox";

        input.checked = initialValue;

        input.addEventListener("change", () => {
            callback(input.checked);
        });

        span.textContent = labelText;

        label.appendChild(input);
        label.appendChild(span);

        return label;
    }

    // Event listener section
    function handleDownloadTorrent() {
        const downloadTorrentBtn = document.querySelector('#tor-reged .dl-stub.dl-link');
        const torrentId = location.search.substr(3);
        const torrentTitle = document.querySelector('h1.maintitle').innerText.trim();
        const torrentUrl = location.href;
        const torrentSize = document.querySelector('#main_content_wrap .dl_list tbody tr:nth-of-type(2) td b:nth-of-type(1)').innerText;

        const topicElement = document.querySelector("#main_content_wrap > table:nth-child(4) > tbody > tr:nth-child(1) > td:nth-child(1) > table > tbody > tr > td.nav > a:nth-child(5)");
        const topicUrl = topicElement.href;
        const topicId = getIdFromUrl(topicUrl, 'topic');
        const topicTitle = topicElement.innerText;
        const torrentTopic = new TorrentTopic(topicId, topicTitle, topicUrl);
        const torrent = new Torrent(torrentId, torrentTitle, torrentUrl, torrentSize, torrentTopic);

        downloadTorrentBtn.addEventListener('click', (event) => {
            downloadTorrent(event, torrent);
        });
    }

    function updateProgressBar(id, percentage) {
        const progressBar = document.getElementById(id);

        if (progressBar) {
            const progress = document.querySelector('.progress-bar');
            progressBar.style.display = 'block';
            progress.style.width = `${percentage}%`;
            progress.textContent = `${percentage}%`;
        }
    }

    // Handles the "download" event.
    function downloadTorrent(event, torrent) {
        const downloadedTorrents = getAllDownloadedTorrents();
        if (isTorrentAlreadyDownloaded(torrent.id)) {
            const response = confirm("Torrent has been marked as downloaded. Redownload?");
            if (!response) {
                event.preventDefault();

                return;
            }
        }

        torrent.downloadDate = new Date().toJSON()
        downloadedTorrents.push(torrent);
        GM_setValue(TORRENT_STORAGE_KEY, downloadedTorrents);
    }

    function getDataForExport() {
        const data = {
            downloadedTorrents: getAllDownloadedTorrents(),
            preferences: getProfilePreferences(),
        };
        return data;
    }

    function getCurrentDateTimeString() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0"); // Months are zero-based, so we add 1
        const day = String(now.getDate()).padStart(2, "0");
        const hour = String(now.getHours()).padStart(2, "0");
        const minutes = String(now.getMinutes()).padStart(2, "0");

        const dateTimeString = `${year}${month}${day}${hour}${minutes}`;
        return dateTimeString;
    }

    // Handles "export" event.
    function initiateExport() {
        const jsonStr = JSON.stringify(getDataForExport());
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);

        const downloadLink = document.createElement("a");
        downloadLink.href = url;
        downloadLink.download = `data${getCurrentDateTimeString()}.json`;
        downloadLink.click();

        URL.revokeObjectURL(url);
        downloadLink.remove();
    }

    function initiateImport() {
        const confirmImport = confirm("Importing will override all current data. Torrent downloads might not be accurate when overriding with older data.");
        if (!confirmImport) {
            return;
        }
        const userInput = window.prompt("Enter export data here:");

        if (userInput !== null) {
            console.debug("Starting import");
            const importData = JSON.parse(userInput);

            const torrentData = importData.downloadedTorrents;
            GM_setValue(TORRENT_STORAGE_KEY, torrentData);

            location.reload();
        } else {
            console.debug("No input provided. Import aborted.");
        }
    }

    // Main (init) section.
    function initializeScript() {
        // Page specific script loading.
        if (checkPage('profile_page')) {
            const downloadedTorrentsTable = generateTorrentsTable(getAllDownloadedTorrents());
            const parent = document.querySelector('#main_content_wrap');

            const wrapperDiv = document.createElement('div');
            wrapperDiv.classList.add('active-torrents-list');
            wrapperDiv.innerHTML = '<div class="table-title">Already downloaded torrents.</div>';
            wrapperDiv.appendChild(downloadedTorrentsTable);
            parent.appendChild(wrapperDiv);

            // User stats (downloaded torrents counter + reset + ratio prediction).
            const usersTable = document.querySelector('table.user_details');
            const ratioPredictionTr = document.createElement('tr');
            const downloadedStatsTr = document.createElement('tr');
            const downloadRemainingTr = document.createElement('tr');

            const predictedRatio = predictRatio();
            const nextRatio = getNearestRatio(predictedRatio);
            const stats = getTorrentStats();
            const nextRatioDept = formatBytes(calculateRequiredUploadRatio(stats.totalDown, stats.totalUp, nextRatio));

            const downloadsRemaining = calculateRemainingDownloadQuota();
            const quotaPercentage = Math.floor((1 - downloadsRemaining / getDownloadQuotaForProfile()) * 100);
            // Update the time display every second
            setInterval(updateTimeToResetDisplay, 1000);
            ratioPredictionTr.innerHTML = `<th>"Actual" ratio:</th><td><div><b>${predictedRatio} (next: ${nextRatio} - ${nextRatioDept} upload needed.).</b><br/><span id="time-to-update"></span></div></td>`;
            downloadedStatsTr.innerHTML = `<th>Torrents downloaded:</th><td><div><b>${countDownloadedToday()}</b></div></td>`;
            const resetDownloadStatElement = document.createElement('a');
            resetDownloadStatElement.href = '#';
            resetDownloadStatElement.textContent = "Reset downloaded torrents.";
            resetDownloadStatElement.addEventListener('click', (e) => {
                e.preventDefault();
                const response = confirm("Reset download stats? Remaining quota might be inaccurate (until next server reset).");
                if (response) {
                    resetTorrentsMarkedAsDownloaded();
                    location.reload();
                }
            });
            downloadedStatsTr.querySelector('td div').appendChild(resetDownloadStatElement);
            downloadRemainingTr.innerHTML = `<th>Torrents download quota left:</th><td><div><b>${generateProgressBar(quotaPercentage, 'download-remaining-bar', downloadsRemaining).outerHTML}</b></div></td>`;

            const lastElement = usersTable.querySelector('#ratio-expl-raw');
            lastElement.insertAdjacentElement('afterend', downloadRemainingTr);
            lastElement.insertAdjacentElement('afterend', downloadedStatsTr);
            lastElement.insertAdjacentElement('afterend', ratioPredictionTr);

            const downloadDataButton = generateButton('bold clickable', `Download user data.`, initiateExport);
            const importDataButton = generateButton('bold clickable', `Import user data.`, initiateImport);
            const resetDataButton = generateButton('bold clickable leech', `Reset to default.`, resetAllData);
            usersTable.querySelector('tr:last-of-type').insertAdjacentElement('afterend', downloadDataButton);
            usersTable.querySelector('tr:last-of-type').insertAdjacentElement('afterend', importDataButton);
            usersTable.querySelector('tr:last-of-type').insertAdjacentElement('afterend', resetDataButton);


            const preferences = getProfilePreferences();
            const hideDownloadedTorrents = preferences?.hideDownloadedTorrents ?? false;
            const toggleContainer = document.getElementById("toggleContainer"); // Replace with your container element ID
            const skipDownloadedToggle = generateToggle("Hide already downloaded torrents.", hideDownloadedTorrents, (checked) => {
                preferences.hideDownloadedTorrents = checked;
                setProfilePreferences(preferences);
            });
            usersTable.querySelector('tr:last-of-type').insertAdjacentElement('afterend', skipDownloadedToggle);
        }

        if (checkPage('torrent_page')) {
            handleDownloadTorrent();
        }

        if (checkPage('tracker_page')) {
            const searchTorrentMatches = getAllDownloadLinksWithString(PREFERRED_VIDEO_FORMATS);
            const pictureTorrentMatches = getAllPicturePacks();
            const torrentMatches = { ...searchTorrentMatches, ...pictureTorrentMatches };
            torrentMatches.all = Object.values(torrentMatches).flat();

            markDownloadedTorrents();

            // Fetch the buttons to be rendered.
            const downloadButtons = generateArrayOfDownloadButtons(torrentMatches);
            const dnwldButtonWrapper = document.createElement('div');
            downloadButtons.forEach((button) => {
                dnwldButtonWrapper.appendChild(button);
            });

            // Create the progress bar to match the progress of the tab opener, but hide it until it's needed.
            const progressBar = generateProgressBar(0, 'torrent-open-tab-progress-bar');
            progressBar.style.display = 'none';

            // Create markup and render the buttons for download groups.
            const searchTableSectionBody = document.querySelector("#tr-form > table > tbody > tr:nth-child(2) > td > table > tbody");
            const buttonsLegendTr = document.createElement('tr');
            const buttonsLegend = generateLegend("Multi tab opener");
            buttonsLegend.setAttribute('colspan', '3');
            buttonsLegend.querySelector('div').appendChild(dnwldButtonWrapper);
            buttonsLegend.querySelector('div').appendChild(progressBar);

            buttonsLegendTr.appendChild(buttonsLegend);
            searchTableSectionBody.appendChild(buttonsLegendTr);
        }

        const logo = document.getElementById('logo-td');
        const leechInfoElement = document.createElement('p');
        leechInfoElement.setAttribute('id', 'freeleech-countdown');
        logo.appendChild(leechInfoElement);
        setInterval(updateFreeleechInfo, 1000);
    }


    initializeScript();
})();
