// ==UserScript==
// @name         PLHelper
// @description  Makes downloading PL torrents easier, as well as having some more clarity on some pages.
// @namespace    http://tampermonkey.net/
// @version      1.0
// @author       Frankenst1
// @match        https://pornolab.net/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pornolab.net
// @updateURL    https://raw.githubusercontent.com/Frankenst1/PLHelper/main/user.script.user.js
// @downloadURL  https://raw.githubusercontent.com/Frankenst1/PLHelper/main/user.script.user.js
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// ==/UserScript==

// TODO: ability to change settings (ability to set preferences (video quality, tags, ...)).
// TODO: add proper debugging.
// TODO: add ability to start downloading the torrents as well?
// TODO: move these constants to a "profile settings" page.
// TODO: handleFormPage and handleTorrentPage have a very similar body. Might be a good idea to have it more abstract and reuse methods between the two for maintainability.
(function () {
    'use strict';

    // ==Constants==
    const TIMEZONE_OFFSET = (24 + (new Date().getTimezoneOffset() + (3 * 60)) / 60) % 24;
    const AVAILABLE_VIDEO_FORMATS = ["1080", "720", "4K", "2160"];
    const URL_DELAY = 1000;
    const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    // Storage keys
    const PROFILE_KEY = 'profile';
    // ==/Constants==

    // ==Classes==
    // TODO: add methods to classes for easier maintenance.
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
        constructor(hideDownloadedTorrents = [], videoFormats = []) {
            this.hideDownloadedTorrents = hideDownloadedTorrents;
            this.videoFormats = videoFormats
        }
    }

    class Profile {
        constructor(preferences = new ProfilePreferences(), ratio = 0, downloadedTorrents = []) {
            this.preferences = preferences;
            this.ratio = {
                ratio: ratio,
                lastUpdated: Date()
            };
            this.downloadedTorrents = downloadedTorrents;
        }
    }
    // ==/Classes==

    // ==CSS==
    GM_addStyle('.lds-ripple { display: inline-block; position: relative; width: 80px; height: 80px; } .lds-ripple div { position: absolute; border: 4px solid #000; opacity: 1; border-radius: 50%; animation: lds-ripple 1s cubic-bezier(0, 0.2, 0.8, 1) infinite; } .lds-ripple div:nth-child(2) { animation-delay: -0.5s; } @keyframes lds-ripple { 0% { top: 36px; left: 36px; width: 0; height: 0; opacity: 0; } 4.9% { top: 36px; left: 36px; width: 0; height: 0; opacity: 0; } 5% { top: 36px; left: 36px; width: 0; height: 0; opacity: 1; } 100% { top: 0px; left: 0px; width: 72px; height: 72px; opacity: 0; } }');
    GM_addStyle('.progress-bar-container { color: #000 !important; background-color: darkgrey !important; } .progress-bar { color: #fff !important; background-color: #607d8b !important; text-align: center; } .progress-bar::after, .progress-bar::before { content: ""; display: table; clear: both; } .progress-bar *:not(span):not(font) { min-width: 60px; display: inline-block; }');
    // ==/CSS==

    // ==Helper methods==
    // Returns "true" if on the correct page.
    function checkPage(page) {
        let cp = location.pathname;
        switch (page) {
            case 'profile_page':
                return cp.includes('profile.php') && document.getElementById('passkey-val');
            case 'tracker_page':
                return cp.includes('tracker.php');
            case 'topic_page':
                return cp.includes('viewtopic.php') && location.search.includes('?t=') && document.querySelector('.dl-link') !== null;
            case 'form_page':
                return cp.includes('viewforum.php');
            default:
                return false;
        }
    }

    function isToday(dateToCheck) {
        // Get today's date
        const today = new Date();

        // Compare the components of the dateToCheck with today's date
        const isSameDate =
            dateToCheck.getDate() === today.getDate() &&
            dateToCheck.getMonth() === today.getMonth() &&
            dateToCheck.getFullYear() === today.getFullYear();

        // Return true if the dateToCheck is today, otherwise return false
        return isSameDate;
    }

    function isTorrentAlreadyDownloaded(torrentId) {
        const downloadedTorrents = getAllDownloadedTorrents();
        return downloadedTorrents.some((obj) => obj.id == torrentId);
    }

    function getAllDownloadedTorrents() {
        const profile = GM_getValue(PROFILE_KEY);

        return profile.downloadedTorrents;
    }

    function getProfilePreferences() {
        const profile = getProfile();

        return profile.preferences;
    }

    function setProfilePreferences(profilePreferences) {
        const profile = getProfile();
        profile.preferences = profilePreferences;
        updateProfile(profile);
    }

    function getPreference(key) {
        const preferences = getProfilePreferences();
        if (Object.prototype.hasOwnProperty.call(preferences, key)) {
            return preferences[key];
        }

        return undefined;
    }

    function getProfile() {
        const profile = GM_getValue(PROFILE_KEY);

        return profile;
    }

    function updateProfile(profile) {
        GM_setValue(PROFILE_KEY, profile);

        console.debug("Profile was updated.");
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

    function getTorrentPage(torrent) {
        return `./viewtopic.php?t=${torrent.id}`;
    }

    function getTorrentDownloadLink(torrent) {
        return `dl.php?t=${torrent.id}`;
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

    function filterEmptyOrFalseTorrent(array) {
        return array.filter(value => value !== false && value !== undefined && value !== null);
    }

    function calculateNearestRatio(ratio) {
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

    function calculateRemainingDownloadQuota() {
        const nDownloaded = calculateDownloadedToday();

        return getDownloadQuotaForProfile() - nDownloaded;
    }

    function calculateDownloadedToday() {
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

    function calculateTimeUntilServerReset() {
        const midnightMSK = getDateMidnightMSK();
        const currentTimeMSK = getServerTime();

        const timeDifference = midnightMSK - currentTimeMSK;

        const hours = Math.floor(timeDifference / (1000 * 60 * 60));
        const minutes = Math.floor((timeDifference % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeDifference % (1000 * 60)) / 1000);

        function getServerTime() {
            const mskOffset = getMSKOffset();
            const now = Date.now();
            const currentTimeMSK = new Date(now + mskOffset);

            return currentTimeMSK;
        }

        // TODO: rework this, there is already something similar existing with the freeleech calculator.
        function getDateMidnightMSK() {
            const mskOffset = getMSKOffset();
            const now = Date.now();
            const currentTimeMSK = new Date(now + mskOffset);

            const midnightMSK = new Date(currentTimeMSK);
            midnightMSK.setUTCHours(21, 0, 0, 0); // 21 corresponds to 00:00 MSK because MSK is UTC+3

            return midnightMSK;
        }

        function getMSKOffset() {
            const date = new Date();
            return date.getTimezoneOffset() * -1; // Convert to positive
        }

        return `${hours} hours, ${minutes} minutes, ${seconds} seconds`;
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

    function resetAllData() {
        const confirmReset = confirm("Reset all to default settings? This cannot be undone.");
        if (confirmReset) {
            GM_deleteValue(PROFILE_KEY);
            location.reload();
        }
    }
    // TODO: this can probably be also be turned into a reusable method for both topic and tracker.
    function mapTrackerToTorrent(trackerRow) {
        const topicElement = trackerRow.querySelector('td:nth-of-type(3)');
        const topicUrl = topicElement.querySelector('a')?.href;
        const topicId = getIdFromUrl(topicUrl, 'topic');
        const topicTitle = topicElement.textContent?.trim();
        const topic = new TorrentTopic(topicId, topicTitle, topicUrl);

        const subjectElement = trackerRow.querySelector('td:nth-of-type(4)');
        const subject = subjectElement.textContent?.trim();
        const url = subjectElement.querySelector('a')?.href;
        const size = trackerRow.querySelector('td:nth-of-type(6)').textContent?.trim();
        const id = url.split('?t=').pop();

        // 3. Create a Torrent class object.
        const torrent = new Torrent(id, subject, url, size, topic);

        if (getPreference('hideDownloadedTorrents') ?? false) {
            // TODO: might be a better idea to filter out when initially filtering?
            if (!isTorrentAlreadyDownloaded(id)) {
                return torrent;
            } else {
                // Mark downloaded download depending on it's setting.
                if (getPreference('hideDownloadedTorrents') ?? false) {
                    topicRow?.setAttribute('style', 'display:none');
                } else {
                    topicElement?.setAttribute('style', 'color:green;');
                }
            }
        } else {
            return torrent;
        }

        return false;
    }
    // ==/Helper methods==

    // ==DOM methods==
    function generateArrayOfDownloadButtons(torrents, elementsId = 'torrent-open-tab') {
        console.log(torrents);
        const downloadButtons = [];

        // TODO: move to different method! + rework for readability.
        Object.keys(torrents).forEach((key, index) => {
            const filter = key;
            const length = torrents[filter]?.length ?? 0;
            const eta = new Date(Date.now() + (length * URL_DELAY)).toLocaleString();

            const progressBarId = `${elementsId}-progress-bar-${index}`;
            const progressBar = generateProgressBar(0, progressBarId, key);

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

                        updateProgressBar(progressBarId, percentage);
                    }, index * URL_DELAY);
                });
            };

            downloadButtons.push({
                button: generateButton('bold clickable', `Download ${length} items (${filter}).`, dwndBtnCallback),
                progressBar: progressBar
            });
        });

        return downloadButtons;
    }

    function generateProgressBar(percentage, id, helperText = null) {
        // Create the outer container div
        const containerDiv = document.createElement('div');
        containerDiv.className = 'progress-bar-container';
        containerDiv.id = id;

        // Create the inner progress bar div
        const progressBarDiv = document.createElement('div');
        progressBarDiv.className = 'progress-bar';
        progressBarDiv.style.width = `${percentage}%`;
        progressBarDiv.style.padding = 0;

        const progressBarValue = document.createElement('span');
        progressBarValue.classList.add('progress-bar-value');
        progressBarValue.textContent = `${percentage}%`;
        progressBarDiv.appendChild(progressBarValue);
        if (helperText) {
            const progressBarText = document.createElement('span');
            progressBarText.textContent = `(${helperText})`;
            progressBarDiv.appendChild(progressBarText);
        }

        // Append the inner progress bar div to the outer container div
        containerDiv.appendChild(progressBarDiv);

        return containerDiv;
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

    function generateTorrentsTable(torrents) {
        if (torrents.length <= 0) {
            const table = document.createElement('table');
            table.className = 'forumline tCenter';
            const row = document.createElement('tr');
            const noResults = document.createElement('td');
            noResults.innerText = 'No torrents downloaded yet.';

            row.appendChild(noResults);
            table.appendChild(row);

            return table;
        }

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
    // ==/DOM methods==

    // ==Handler methods==
    function showFreeleechCountdown() {
        const logo = document.getElementById('logo-td');
        const leechInfoElement = document.createElement('p');
        leechInfoElement.setAttribute('id', 'freeleech-countdown');
        logo.appendChild(leechInfoElement);

        setInterval(() => {
            const leechInfoElement = document.getElementById('freeleech-countdown');
            leechInfoElement.innerText = getFreeleechInfo();
        }, 1000);

        // The text that gets shown for the next/current freeleech event.
        function getFreeleechInfo() {
            const today = new Date();
            const nextFreeleechDate = getNextFreeleechDate();
            const freeleechStart = nextFreeleechDate;
            const isFreeleechDay = isToday(nextFreeleechDate);

            // Return next freeleech date START date.
            function getNextFreeleechDate() {
                const now = new Date();
                let nextFreeleechDate = getLastSaturday(now.getFullYear(), now.getMonth(), 0);

                // If current month has already had freeleech, get next month's.
                if (nextFreeleechDate < now && !isToday(nextFreeleechDate)) {
                    nextFreeleechDate = getLastSaturday(now.getFullYear(), now.getMonth() + 1, 0);
                }

                // Simply fetches the last saturday of a given year + month.
                function getLastSaturday(year, month) {
                    const lastDayOfMonth = new Date(year, month + 1, 0);
                    const dayOfWeek = lastDayOfMonth.getDay();
                    const daysUntilLastSaturday = (dayOfWeek + 1) % 7; // Adding 1 to convert Sunday (0) to 1
                    const lastSaturdayDate = lastDayOfMonth.getDate() - daysUntilLastSaturday;
                    let timezoneOffset = TIMEZONE_OFFSET;

                    let lastSaturday = new Date(year, month, lastSaturdayDate);
                    lastSaturday.setHours(lastSaturday.getHours() - timezoneOffset);

                    return lastSaturday;
                }

                return nextFreeleechDate;
            }

            let timeUntilEvent = null;
            if (isFreeleechDay) {
                // countdown = end of current freeleech period.
                let midnightNextDay = new Date();
                midnightNextDay.setDate(midnightNextDay.getDate() + 1);
                midnightNextDay.setHours(0, 0, 0, 0);
                midnightNextDay.setHours(midnightNextDay.getHours() - TIMEZONE_OFFSET)

                timeUntilEvent = midnightNextDay - today;
            } else {
                // event = start of next freeleech period.
                timeUntilEvent = freeleechStart - today;
            }

            const daysUntilEvent = Math.floor(timeUntilEvent / (1000 * 60 * 60 * 24));
            const hoursUntilEvent = Math.floor((timeUntilEvent % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutesUntilEvent = Math.floor((timeUntilEvent % (1000 * 60 * 60)) / (1000 * 60));
            const secondsUntilEvent = Math.floor((timeUntilEvent % (1000 * 60)) / 1000);
            const timer = `(${daysUntilEvent}d ${hoursUntilEvent}h ${minutesUntilEvent}m ${secondsUntilEvent}s)`;

            if (isFreeleechDay) {
                return (`Freeleech day! Time left: ${timer}`);
            }

            return `Next freeleech event: ${timer} @ ${nextFreeleechDate}.`;
        }
    }

    function handleTrackerPage() {
        // 1. Prepare all torrent data
        const torrents = handleTorrentRows();
        // 2. add elements to UI.
        addElements(torrents);

        // Helper functions specific for tracker page.
        // TODO: might be ideal to make a more generic method from this, as it's reused partially.
        function handleTorrentRows() {
            // 1. Get all torrent rows
            const torrentRows = document.querySelectorAll('#main_content table#tor-tbl tr.tCenter');
            // 2. Get already downloaded torrents to potentially cross-check. (can be removed as this check happens on map.)
            const downloadedtorrents = getAllDownloadedTorrents();
            // 3. Handle each "type". (TODO: this method should be globally available).
            function getAllVideoRows(torrentRows) {
                // TODO: Get from preferences after preferences has been fully implemented.
                const prefVideoFormats = AVAILABLE_VIDEO_FORMATS;

                const filteredTorrentsByVideoFormatPrefs = {};
                prefVideoFormats.forEach(videoFormat => {
                    const filteredTorrentRows = Array.from(torrentRows).filter(row => row.textContent.includes(videoFormat));
                    const filteredTorrents = filterEmptyOrFalseTorrent(filteredTorrentRows.map(mapTrackerToTorrent));

                    filteredTorrentsByVideoFormatPrefs[videoFormat] = filteredTorrents;
                });

                return filteredTorrentsByVideoFormatPrefs;
            }

            function getAllPictureRows(torrentRows) {
                const pictureTopics = getPictureTopics();

                return Array.from(torrentRows).filter(row => {
                    // Topic is the 3rd column of a tracker row.
                    const topicUrl = row.querySelector('td:nth-of-type(3) a').getAttribute('href');

                    return pictureTopics.some(topicId => topicUrl.includes(`f=${topicId}`));
                });
            }

            function getAllUncenRows(torrentRows) {
                const uncenFilteredTorrentRows = Array.from(torrentRows).filter(row => {
                    const lowercasedText = row.textContent.toLowerCase();
                    return lowercasedText.includes('uncen') || (!lowercasedText.includes('ptcen') && !lowercasedText.includes('cen'));
                });
                
                return filterEmptyOrFalseTorrent(uncenFilteredTorrentRows.map(mapFormPostToTorrent));
            }

            function getAllRows(torrentRows) {
                return filterEmptyOrFalseTorrent(Array.from(torrentRows).map(mapTrackerToTorrent));
            }

            // TODO: add "other" which contains all torrent that are not included in any group (except for 'all').
            const torrents = {
                Video: getAllVideoRows(torrentRows),
                Pictures: [...getAllPictureRows(torrentRows)],
                Uncen: [...getAllUncenRows(torrentRows)],
                All: [...getAllRows(torrentRows)]
            };

            return torrents;
        }

        function getAllTopics() {
            const topicOptions = document.querySelectorAll('select#fs-main option');
            const topics = [];
            Array.from(topicOptions).map((option) => {
                const topicId = option.getAttribute('value');
                const topicTitle = option.innerText.replace(/^\|-\s*/, '');

                const topic = new TorrentTopic(topicId, topicTitle, '#');
                topics.push(topic);
            });

            return topics;
        }

        function getPictureTopics() {
            // TODO: might be a good idea to just manually fetch the IDs?
            const allowedTopics = ["MetArt", "Picture", "Misc", "Magazines", "Photo", "Hentai: main subsection", "Manga", "Art", "HCG", "Cartoons", "Comics"];
            const topicIds = getAllTopics()
                .filter(topic => {
                    const topicToCheck = topic.title.toLowerCase();
                    return allowedTopics.some(word => topicToCheck.includes(word.toLowerCase()));
                })
                .map(topic => topic.id);

            if (topicIds.length == 0) {
                return [];
            }

            return topicIds;
        }

        function addElements(torrents) {
            // Create the new legend with all new elements.
            const buttonsLegend = generateLegend("Torrent opener (tabs)");
            buttonsLegend.setAttribute('colspan', '3');
            const downloadButtonWrapper = document.createElement('div');
            const progressBarWrapper = document.createElement('div');

            const downloadButtons = generateArrayOfDownloadButtons(torrents);
            // Add button and progress bar to their respective wrapper.
            downloadButtons.forEach((downloadButton, index) => {
                const button = downloadButton.button;
                const progressBar = downloadButton.progressBar;
                progressBar.style.display = 'none';
                if (index > 0) {
                    button.style.marginLeft = '10px';
                    progressBar.marginTop = '10px';
                }
                // Add button to wrapper
                downloadButtonWrapper.appendChild(button);
                progressBarWrapper.appendChild(progressBar);
            });
            // Add wrappers to the buttons legend.
            buttonsLegend.querySelector('div').appendChild(downloadButtonWrapper);
            buttonsLegend.querySelector('div').appendChild(progressBarWrapper);

            // Get location and add the element legend there.
            const searchTableBody = document.querySelector("#tr-form > table > tbody > tr:nth-child(2) > td > table > tbody");
            const elementsRow = document.createElement('tr');
            elementsRow.appendChild(buttonsLegend);
            searchTableBody.appendChild(elementsRow);
        }
    }

    function handleProfilePage() {
        addElements();

        function addElements() {
            addTorrentsTable();
            showRatioPredictions();
            showRemainingDownloads();
            updateProfileWithProfileData();

            function addTorrentsTable() {
                const contentWrap = document.querySelector('#main_content_wrap');
                const downloadedTorrentsTable = generateTorrentsTable(getAllDownloadedTorrents());
                // Prepare the downloaded Torrents element + add to view.
                const downloadedTorrentsWrapper = document.createElement('div');
                downloadedTorrentsWrapper.classList.add('active-torrents-list');
                downloadedTorrentsWrapper.innerHTML = '<div class="table-title">Already downloaded torrents.</div>';
                downloadedTorrentsWrapper.appendChild(downloadedTorrentsTable);
                contentWrap.appendChild(downloadedTorrentsWrapper);
            }

            // Calculate uer stats with data from user profile page.
            function showRatioPredictions() {
                const userRatio = document.getElementById('u_ratio');
                const ratioPredictionTr = document.createElement('tr');

                const predictedRatio = predictRatio();
                const nextRatio = calculateNearestRatio(predictedRatio);
                const stats = getTorrentStatsFromProfilePage();
                const nextRatioDept = formatBytes(calculateRequiredUploadRatio(stats.totalDown, stats.totalUp, nextRatio));

                // TODO: Show time & update time display every second when next reset is.
                ratioPredictionTr.innerText = `Ratio after reset: ${predictedRatio}. Next ratio: ${nextRatio} (${nextRatioDept} upload to go).`
                userRatio.appendChild(ratioPredictionTr);
            }

            // TODO: move parts of this to a generic one, so it can be reused on other pages.
            function showRemainingDownloads() {
                const userTable = document.querySelector("#main_content_wrap > table > tbody > tr:nth-child(2) > td:nth-child(2) > table > tbody");
                const downloadStatsRow = document.createElement('tr');

                const downloadStatsHeader = document.createElement('th');
                downloadStatsHeader.innerText = 'Downloads left today:'

                const downloadsRemainingData = document.createElement('td');
                const downloadsRemaining = calculateRemainingDownloadQuota();
                const quotaPercentage = Math.floor((1 - downloadsRemaining / getDownloadQuotaForProfile()) * 100);
                const progressBar = generateProgressBar(quotaPercentage, 'downloads-quota-left', `${downloadsRemaining} left.`)
                downloadsRemainingData.appendChild(progressBar);

                downloadStatsRow.appendChild(downloadStatsHeader);
                downloadStatsRow.appendChild(downloadsRemainingData);

                console.log(downloadStatsRow);
                console.log(userTable);
                userTable.appendChild(downloadStatsRow);
            }

            function updateProfileWithProfileData() {
                const profile = getProfile();
                profile.ratio = {
                    ratio: document.getElementById('u_ratio').innerText.trim(),
                    lastUpdated: new Date()
                }
            }

            // Generate user stats:
        }

        // Handler specific helper methods
        function getTorrentStatsFromProfilePage() {
            var sizeRegex = /^([\d.,]+)\s*([a-zA-Z]+)/;

            // Help class to easily fetch the data we care about.
            function getSizeValue(element) {
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
            // TODO: get stats: but not from profile page, save it in preferences.
            const stats = getTorrentStatsFromProfilePage();
            const rating = stats.totalDown !== 0 ? (stats.totalUp + stats.totalRelease + stats.totalBonus) / stats.totalDown : 0;

            return Math.floor(rating * 100) / 100;
        }
    }

    function handleTorrentPage() {
        registerEventListeners();

        function registerEventListeners() {
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
                hanldeDownloadTorrent(event, torrent);
            });
        }

        function hanldeDownloadTorrent(event, torrent) {
            const downloadedTorrents = getAllDownloadedTorrents();
            if (isTorrentAlreadyDownloaded(torrent.id)) {
                const response = confirm("Torrent has been marked as downloaded. Redownload?");
                if (!response) {
                    event.preventDefault();

                    return;
                }
            }

            // Add torrent to profile.
            torrent.downloadDate = new Date().toJSON()
            downloadedTorrents.push(torrent);
            const profile = getProfile();
            profile.downloadedTorrents = downloadedTorrents
            updateProfile(profile);
        }
    }

    function updateProgressBar(id, percentage) {
        const progressBarWrapper = document.getElementById(id);
        const progressBar = progressBarWrapper.querySelector('.progress-bar')

        if (progressBarWrapper && progressBar) {
            progressBarWrapper.style.display = 'block';
            progressBar.style.width = `${percentage}%`;
            progressBar.querySelector('span.progress-bar-value').textContent = `${percentage}%`;
        }
    }

    function handleFormPage() {
        alert("Not yet implemented!");

        function oldUnrefactoredCode() {
            // TODO: get and map everything, then filter/assign to correct object instead of filtering/looping 3 times.

            // Get all video stuff.
            // TODO: Rework this to be used in tracker_page and maybe have some similar functions between the two. Apart from mapping/fetching tr's, they should be similar.
            const torrentRows = document.querySelectorAll('#main_content table.forum tr[id]');
            const downloadedtorrents = getAllDownloadedTorrents();
            const prefVideoFormats = getPreference('videoFormats');

            const filteredTorrentsByVideoFormatPrefs = {};
            prefVideoFormats.forEach(videoFormat => {
                const filteredTorrentRows = Array.from(torrentRows).filter(row => row.textContent.includes(videoFormat));
                const filteredTorrents = filterEmptyOrFalseTorrent(filteredTorrentRows.map(mapTopicToTorrent));

                filteredTorrentsByVideoFormatPrefs[videoFormat] = filteredTorrents;
            });
            // Get all "picture" stuff.

            // Get all "non cen"
            const uncenFilteredTorrentRows = Array.from(torrentRows).filter(row => {
                const lowercasedText = row.textContent.toLowerCase();
                return lowercasedText.includes('uncen') || (!lowercasedText.includes('ptcen') && !lowercasedText.includes('cen'));
            });
            const uncenFilteredTorrents = filterEmptyOrFalseTorrent(uncenFilteredTorrentRows.map(mapTopicToTorrent));

            // Get EVERYTHING.
            const allTorrents = filterEmptyOrFalseTorrent(Array.from(torrentRows).map(mapTopicToTorrent));

            // TODO: add "other" which contains all torrent that are not included in any group (except for 'all').
            const torrents = { Video: filteredTorrentsByVideoFormatPrefs, Uncen: [...uncenFilteredTorrents], All: [...allTorrents] };
            console.log("tors?", torrents);
        }
    }
    // ==/Handler methods==

    // ==Main==
    function initializeScript() {
        // Initialize the profile (if no profile has been set yet.) - This should only happen once.
        if (!getProfile()) {
            console.debug("No profile is found. Assuming first run. Creating new profile.");
            const profile = new Profile();
            updateProfile(profile);
        }

        // Page specific script loading.
        if (checkPage('profile_page')) {
            handleProfilePage();
        }

        if (checkPage('topic_page')) {
            handleTorrentPage();
        }

        if (checkPage('form_page')) {
            handleFormPage();
        }

        if (checkPage('tracker_page')) {
            handleTrackerPage();
        }
        // Methods for all pages after this.
        showFreeleechCountdown();
    }

    function migrateStorage() {
        // Check if data is present in one of the old keys.
        const TORRENT_STORAGE_KEY = 'downloadedTorrents';
        const PROFILE_PREFERENCES_KEY = 'profile_preferences';

        if (GM_getValue(TORRENT_STORAGE_KEY)) {
            let profile = getProfile();
            profile.downloadedTorrents = GM_getValue(TORRENT_STORAGE_KEY);
            updateProfile(profile);
            GM_deleteValue(TORRENT_STORAGE_KEY);

            console.info("Torrent storage has been migrated.")
        }
    }
    // ==/Main==

    migrateStorage();
    initializeScript();
})();