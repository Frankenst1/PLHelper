// ==UserScript==
// @name         PLHelper
// @description  Makes downloading PL torrents easier, as well as having some more clarity on some pages.
// @namespace    http://tampermonkey.net/
// @version      2.2.0
// @author       Frankenst1
// @match        https://pornolab.net/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pornolab.net
// @updateURL    https://raw.githubusercontent.com/Frankenst1/PLHelper/main/user.script.user.js
// @downloadURL  https://raw.githubusercontent.com/Frankenst1/PLHelper/main/user.script.user.js
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// ==/UserScript==

// TODO: add ability to start downloading the torrents as well?
(function () {
    'use strict';

    const scriptVersion = GM_info.script.version;

    GM_addStyle('.progress-bar-container { color: #000 !important; background-color: darkgrey !important; } .progress-bar { color: #fff !important; background-color: #607d8b !important; text-align: center; } .progress-bar::after, .progress-bar::before { content: ""; display: table; clear: both; } .progress-bar *:not(span):not(font) { min-width: 60px; display: inline-block; }');

    GM_addStyle(`
        .fade {
            transition: opacity 0.5s ease-in-out;
            opacity: 0;
        }
        .fade.show {
            opacity: 1;
        }
    `);

    GM_addStyle("#settings-pane > fieldset { padding: 5px; margin-bottom: 10px; } #settings-pane > div > button:not(:last-of-type) { color: green; margin-right: 10px; }")

    GM_addStyle('th[data-sort="desc"]::after { content: "↓" } th[data-sort="asc"]::after { content: "↑"}');

    // ==Configuration==
    const Config = {
        SERVER_TIMEZONE: 'Europe/Moscow',
        SERVER_TIMEZONE_OFFSET_UTC: 3,
        AVAILABLE_VIDEO_FORMATS: ["1080", "720", "4K", "2160"],
        URL_DELAY: 1000,
        SIZE_UNITS: ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
        TARGET_RATIOS: [0.3, 0.5, 1.0],
        STORAGE_KEYS: {
            PROFILE: 'profile',
            SETTINGS: 'settings'
        },
        DEBUG_MODE: true,
        ELEMENT_NAME_PREFIX: 'PLHelper_',
        DEFAULT_BATCH_OPENER_STATE: true,
    };

    // Define constants for frequently used selectors
    const SELECTORS = {
        profilePage: '#main_content_wrap',
        trackerPageRows: '#main_content table#tor-tbl tr.tCenter',
        formPageRows: '#main_content table.forum tr[id]',
        torrentPageTitle: 'h1.maintitle',
        torrentPageSize: '#main_content_wrap .dl_list tbody tr:nth-of-type(2) td b:nth-of-type(1)',
        torrentPageTopic: "#main_content_wrap .nav a:nth-last-of-type(2)",
        downloadButton: '#tor-reged .dl-stub.dl-link',
        logo: '#logo',
        logoTd: '#logo-td',
        profileName: 'a[href*="profile.php"]',
    };

    // ==Data Structures==
    class Torrent {
        constructor(id, title, pageUrl, size, topic, downloadDate = null, savedDate = null) {
            this.id = id;
            this.title = title;
            this.pageUrl = pageUrl;
            this.size = size;
            this.topic = topic;
            this.downloadDate = downloadDate;
            this.savedDate = savedDate;
        }

        isDownloaded(downloadedTorrents) {
            return downloadedTorrents.some(torrent => torrent.id === this.id);
        }
    }

    class TorrentTopic {
        constructor(id, title, pageUrl = null) {
            this.id = id;
            this.title = title;
            this.pageUrl = pageUrl || `./forum/tracker.php?f=${id}`;
        }
    }

    class Profile {
        constructor(
            preferences = {
                hideDownloadedTorrents: false
            },
            stats = {
                ratio: 0,
                uploaded: 0,
                downloaded: 0,
                soloUpload: 0,
                bonus: 0,
                lastUpdated: new Date().toString()
            },
            downloadedTorrents = [],
            torrentList = [],
            version = scriptVersion,
            passKey = ''
        ) {
            this.preferences = preferences;
            this.stats = stats;
            this.downloadedTorrents = downloadedTorrents;
            this.torrentList = torrentList;
            this.version = version;
            this.passKey = passKey;
        }

        addDownloadedTorrent(torrent) {
            Utils.logDebug("adding torrent to downloaded torrents: ", torrent);
            this.downloadedTorrents.push(torrent);
        }

        removeDownloadedTorrent(torrentId) {
            this.downloadedTorrents = this.downloadedTorrents.filter(torrent => torrent.id !== torrentId);
        }

        addTorrentToList(torrent) {
            Utils.logDebug("adding torrent to list: ", torrent);
            this.torrentList.push(torrent);
        }

        removeTorrentFromList(torrentId) {
            this.torrentList = this.torrentList.filter(torrent => torrent.id !== torrentId);
        }

        updateStats(stats) {
            this.stats = { ...this.stats, ...stats };
        }

        updateStatsFromProfilePage() {
            // Fetch stats from the page
            const ratio = parseFloat(document.querySelector('#u_ratio b.gen')?.textContent || 0);

            const uploaded = Utils.parseSize(document.querySelector('#u_up_total span.editable.bold')?.textContent)
            const downloaded = Utils.parseSize(document.querySelector('#u_down_total span.editable.bold')?.textContent);
            const soloUpload = Utils.parseSize(document.querySelector('#u_up_release span.editable.bold')?.textContent);
            const bonus = Utils.parseSize(document.querySelector('#u_up_bonus span.editable.bold')?.textContent);

            // Update all stats in one call
            this.updateStats({
                ratio: ratio,
                uploaded: Utils.convertSizeBetweenUnits(uploaded.value, uploaded.unit, 'B'),
                downloaded: Utils.convertSizeBetweenUnits(downloaded.value, downloaded.unit, 'B'),
                soloUpload: Utils.convertSizeBetweenUnits(soloUpload.value, soloUpload.unit, 'B'),
                bonus: Utils.convertSizeBetweenUnits(bonus.value, bonus.unit, 'B'),
                lastUpdated: new Date().toString()
            });

            Utils.logDebug('Profile stats updated from page:', this.stats);
        }

        predictRatio() {
            const { uploaded, downloaded } = this.stats;
            const additionalUpload = 0; // Assume no additional upload for now
            return downloaded > 0 ? (uploaded + additionalUpload) / downloaded : 0;
        }

        calculateRequiredUpload(targetRatio) {
            const { uploaded, downloaded } = this.stats;

            if ((uploaded / downloaded) >= targetRatio) {
                Utils.logDebug(`Upload quota already reached for target ratio ${targetRatio}`);
                return 0;
            }

            // Calculate the required upload
            const requiredUpload = targetRatio * downloaded - uploaded;
            return Math.max(0, requiredUpload); // Ensure non-negative result
        }
    }

    // ==Utilities==
    class Utils {
        static logDebug(message, ...data) {
            if (Config.DEBUG_MODE) {
                console.debug(`[PLHelper Debug]: ${message}`, ...data);
            }
        }

        static convertSizeBetweenUnits(value, fromUnit, toUnit = 'B') {
            const fromIndex = Config.SIZE_UNITS.indexOf(fromUnit);
            const toIndex = Config.SIZE_UNITS.indexOf(toUnit);

            if (fromIndex === -1 || toIndex === -1) {
                throw new Error('Invalid unit provided');
            }

            const bytes = value * Math.pow(1024, fromIndex);
            return Number((bytes / Math.pow(1024, toIndex)).toFixed(2));
        }

        static parseIdFromUrl(url, type) {
            let id;
            switch (type) {
                case 'topic':
                    id = url.split('?f=').pop();
                    break;
                case 'torrent':
                    id = url.split('?t=').pop();
                    break;
                default:
                    this.logDebug(`Invalid URL type: ${type}`);
                    return null;
            }
            return id;
        }

        static checkPage(page) {
            const currentPath = location.pathname;
            switch (page) {
                case 'profile_page':
                    return currentPath.includes('profile.php') && document.getElementById('passkey-val') !== null;
                case 'tracker_page':
                    return currentPath.includes('tracker.php');
                case 'topic_page':
                    return currentPath.includes('viewtopic.php') && location.search.includes('?t=') && document.querySelector('.dl-link') !== null;
                case 'form_page':
                    return currentPath.includes('viewforum.php');
                default:
                    return false;
            }
        }

        static calculateNextRatio(currentRatio) {
            return Config.TARGET_RATIOS.find(ratio => ratio > currentRatio) || currentRatio;
        }

        static parseSize(valueWithUnit) {
            const match = valueWithUnit.match(/^([\d.]+)\s*([A-Za-z]+)$/);
            if (match) {
                return {
                    value: parseFloat(match[1]),
                    unit: match[2]
                };
            } else {
                return null;
            }
        }

        static formatBytes(valueInBytes) {
            let unitIndex = 0;
            let value = valueInBytes;

            // Loop to find the highest unit that's >= 1
            while (value >= 1024 && unitIndex < Config.SIZE_UNITS.length - 1) {
                value /= 1024;
                unitIndex++;
            }

            // Use your existing utility method to convert to the appropriate unit
            const formattedValue = Number(value.toFixed(2));
            const unit = Config.SIZE_UNITS[unitIndex];

            return `${formattedValue} ${unit}`;
        }

        static formatCountdown(ms) {
            const totalSeconds = Math.floor(ms / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;

            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }

        static toSnakeCase(str) {
            return str
                .trim() // Remove leading and trailing whitespace
                .toLowerCase() // Convert to lowercase
                .replace(/[\s]+/g, '_') // Replace spaces and dashes with underscores
                .replace(/[^\w_]/g, ''); // Remove any characters that are not letters, numbers, or underscores
        }

        static trimExcessWhitespace(str) {
            return str
                .trim() // Remove leading and trailing whitespace
                .replace(/\s+/g, ' '); // Replace multiple spaces with a single space
        }
    }

    // ==Migration (1.X -> 2.X)==
    class ProfileMigration {
        static followsProfileStructure(obj, classRef) {
            // Step 1: Check if all instance properties match the structure
            const instance = new classRef(); // Create a dummy instance of the class
            const instanceKeys = Reflect.ownKeys(instance);

            const hasSameProperties = instanceKeys.every((key) => {
                // Ensure the object has the property and its type matches
                return (
                    key in obj &&
                    typeof instance[key] === typeof obj[key]
                );
            });

            // Step 2: Check if all methods match the structure
            const classMethods = Object.getOwnPropertyNames(classRef.prototype).filter(
                (key) => typeof classRef.prototype[key] === "function"
            );

            const hasSameMethods = classMethods.every((method) => {
                return typeof obj[method] === "function";
            });

            // Return true only if both properties and methods match
            return hasSameProperties && hasSameMethods;
        }

        static isLegacyProfile(profile) {
            return !this.followsProfileStructure(profile, Profile);
        }

        static convertOldProfileToNew(oldProfile) {
            // Step 1: Convert preferences (assuming the new Profile class has similar preferences structure)
            const preferences = {
                hideDownloadedTorrents: oldProfile.preferences?.hideDownloadedTorrents || false,
                videoFormats: oldProfile.preferences?.videoFormats || []
            };

            // Step 2: Convert stats
            const stats = {
                ratio: oldProfile.stats?.ratio || 0,
                uploaded: oldProfile.stats?.uploaded || 0,
                downloaded: oldProfile.stats?.downloaded || 0,
                soloUpload: oldProfile.stats?.soloUpload || 0,
                bonus: oldProfile.stats?.bonus || 0,
                lastUpdated: oldProfile.stats?.lastUpdated || new Date().toString()
            };

            // Step 3: Convert downloadedTorrents (map old downloadedTorrents to new Torrent instances)
            const downloadedTorrents = oldProfile.downloadedTorrents.map(torrent => {
                const topic = new TorrentTopic(
                    torrent.topic.id,
                    torrent.topic.title,
                    torrent.topic.pageUrl
                );

                return new Torrent(
                    torrent.id,
                    torrent.title,
                    torrent.pageUrl,
                    torrent.size,
                    topic,
                    torrent.downloadDate
                );
            });

            // Step 4: Create and return the new Profile instance
            return new Profile(preferences, stats, downloadedTorrents);
        }
    };

    // ==Storage Manager==
    class StorageManager {
        static get(key, defaultValue) {
            return GM_getValue(key, defaultValue);
        }

        static set(key, value) {
            GM_setValue(key, value);
        }

        static delete(key) {
            GM_deleteValue(key);
        }

        static loadProfile() {
            const rawProfile = this.get(Config.STORAGE_KEYS.PROFILE);
            if (!rawProfile) {
                // Redirect to the profile page to update the stats since we don't have any profile.
                window.location.href = document.querySelector(SELECTORS.profileName).href;
                return new Profile();
            }
            return new Profile(rawProfile.preferences, rawProfile.stats, rawProfile.downloadedTorrents, rawProfile.torrentList, rawProfile.passKey);
        }

        static saveProfile(profile) {
            Utils.logDebug("Profile has been saved", profile);
            this.set(Config.STORAGE_KEYS.PROFILE, profile);
        }

        static loadSettings() {
            const rawSettings = this.get(Config.STORAGE_KEYS.SETTINGS, {
                hideDownloadedTorrents: false,
                preferredFormats: Config.AVAILABLE_VIDEO_FORMATS,
                batchOpenerState: Config.DEFAULT_BATCH_OPENER_STATE // Default value
            });
            // No transformation needed unless settings become more complex
            return rawSettings;
        }

        static saveSettings(settings) {
            this.set(Config.STORAGE_KEYS.SETTINGS, settings);
        }

        static exportTampermonkeyStorage() {
            const storage = {};
            const keys = GM_listValues(); // Get all the keys from Tampermonkey storage

            // Loop through each key and get the corresponding value
            keys.forEach(key => {
                storage[key] = StorageManager.get(key);
            });

            const data = JSON.stringify(storage); // Convert the storage data to JSON
            const blob = new Blob([data], { type: 'application/json' }); // Create a Blob object
            const url = URL.createObjectURL(blob); // Create an object URL for the Blob

            // Create a downloadable link and click it to trigger the download
            const a = document.createElement('a');
            a.href = url;
            a.download = 'tampermonkeyStorageBackup.json'; // Set the filename for the download
            a.click(); // Programmatically click the link to download the file

            // Clean up
            URL.revokeObjectURL(url);
        }

        static importTampermonkeyStorage(event) {
            const file = event.target.files[0]; // Get the selected file
            const reader = new FileReader(); // Create a FileReader to read the file

            reader.onload = function () {
                try {
                    const data = JSON.parse(reader.result); // Parse the JSON data from the file

                    // Iterate over each key-value pair and save it in Tampermonkey storage
                    for (const key in data) {
                        if (Object.prototype.hasOwnProperty.call(data, key)) {
                            StorageManager.set(key, data[key]);
                        }
                    }

                    const message = 'Tampermonkey storage data imported successfully!';
                    Utils.logDebug(message);
                    alert(message);
                    window.location.reload();

                } catch (error) {
                    console.error('Error importing Tampermonkey storage data:', error);
                    alert('Failed to import data.');
                }
            };

            reader.readAsText(file); // Read the file as text
        }

        // Function to clear all Tampermonkey storage data
        static clearTampermonkeyStorage() {
            const keys = GM_listValues(); // Get all keys from Tampermonkey storage

            // Loop through each key and delete it
            keys.forEach(key => {
                StorageManager.delete(key);
            });

            alert('All Tampermonkey storage data has been cleared!');
            window.location.reload();
        }
    };

    // ==Quota Manager==
    class QuotaManager {
        static calculateDailyQuota(profile) {
            const { ratio, uploaded, downloaded } = profile.stats;

            if (ratio >= 1.0) {
                if (uploaded >= 100) {
                    return 100;
                } else {
                    return 50;
                }
            } else if (ratio >= 0.5) {
                return 50;
            } else if (ratio >= 0.3) {
                return 10;
            } else if (downloaded < 2) {
                return 5;
            } else {
                return 0;
            }
        }

        static calculateDownloadedToday(profile) {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);

            const todayEnd = new Date();
            todayEnd.setHours(23, 59, 59, 999);

            return profile.downloadedTorrents.filter(torrent => {
                const torrentDate = new Date(torrent.downloadDate);
                return torrentDate >= todayStart && torrentDate <= todayEnd;
            }).length;
        }

        static calculateRemainingQuota(profile) {
            const dailyQuota = this.calculateDailyQuota(profile);
            const downloadedToday = this.calculateDownloadedToday(profile);

            return Math.max(0, dailyQuota - downloadedToday);
        }
    };

    // ==Torrent Mapper==
    class TorrentMapper {
        static mapTrackerToTorrent(trackerRow, profile) {
            return this.mapRowToTorrent(
                trackerRow,
                profile,
                'td:nth-of-type(3)', // Topic element selector
                'td:nth-of-type(4)', // Subject element selector
                'td:nth-of-type(6)'  // Size element selector
            );
        }

        static mapFormPostToTorrent(formRow, profile) {
            // Skip announcements
            if (/(announce)/.test(formRow.querySelector('img.topic_icon')?.src)) {
                return null;
            }

            return this.mapRowToTorrent(
                formRow,
                profile,
                '#main_content_wrap .nav.nav-top a:last-of-type', // Topic element selector
                'td:nth-of-type(2)', // Subject element selector
                'td:nth-of-type(3) .dl-stub'  // Size element selector (fallback to 'unknown')
            );
        }

        static mapRowToTorrent(row, profile, topicSelector, subjectSelector, sizeSelector) {
            const topicElement = row.querySelector(topicSelector);
            const topicUrl = topicElement?.href || topicElement?.querySelector('a')?.href;
            let topicId;

            if (topicUrl) {
                topicId = Utils.parseIdFromUrl(topicUrl, 'topic');
            } else {
                topicId = Utils.parseIdFromUrl(location.href, 'topic');
            }

            const topicTitle = topicElement?.textContent?.trim();
            const topic = new TorrentTopic(topicId, topicTitle, topicUrl);

            const subjectElement = row.querySelector(subjectSelector);
            const subject = subjectElement?.textContent?.trim();
            const url = subjectElement?.querySelector('a')?.href;
            const size = row.querySelector(sizeSelector)?.textContent?.trim() || 'unknown';
            const id = Utils.parseIdFromUrl(url, 'torrent');

            const torrent = new Torrent(id, subject, url, size, topic);

            // Filtering logic based on user preferences
            if (profile.preferences.hideDownloadedTorrents && torrent.isDownloaded(profile.downloadedTorrents)) {
                row.style.display = 'none';
                //return null;
            }

            return torrent;
        }
    };

    // ==Time Helpers==
    class TimeHelpers {
        static getNextFreeLeechTime() {
            const now = new Date();

            // Adjust the current time to the server's timezone
            const nowServerTime = new Date(now.getTime() + Config.SERVER_TIMEZONE_OFFSET_UTC * 60 * 60 * 1000);  // Server time in GMT+3

            // Get the last day of the current month in server time
            const lastDayOfMonth = new Date(nowServerTime.getFullYear(), nowServerTime.getMonth() + 1, 0);

            // Backtrack from the last day of the month to find the last Saturday in server time
            const lastSaturday = new Date(lastDayOfMonth);
            lastSaturday.setHours(0, 0, 0, 0); // Reset to midnight to ensure the date is set properly
            while (lastSaturday.getDay() !== 6) {  // getDay() returns 6 for Saturday
                lastSaturday.setDate(lastSaturday.getDate() - 1);
            }

            // If nowServerTime is after the last Saturday, calculate the next month's last Saturday
            if (nowServerTime > lastSaturday && nowServerTime.toDateString() !== lastSaturday.toDateString()) {
                const nextMonthLastDay = new Date(nowServerTime.getFullYear(), nowServerTime.getMonth() + 2, 0);
                const nextLastSaturday = new Date(nextMonthLastDay);
                nextLastSaturday.setHours(0, 0, 0, 0); // Reset to midnight
                while (nextLastSaturday.getDay() !== 6) {
                    nextLastSaturday.setDate(nextLastSaturday.getDate() - 1);
                }
                return new Date(nextLastSaturday.getTime() - (TimeHelpers.getTimezoneOffsetInMinutes('Europe/Moscow') / 60) * 60 * 60 * 1000); // Adjust by -2 hours to reflect local time (GMT+1)
            }

            // If it's today and still valid, return this month's last Saturday in server time
            return new Date(lastSaturday.getTime() - (TimeHelpers.getTimezoneOffsetInMinutes('Europe/Moscow') / 60) * 60 * 60 * 1000); // Adjust by -2 hours to reflect local time (GMT+1)
        }

        static calculateTimeUntilFreeleech() {
            const now = new Date();
            const nextFreeleech = this.getNextFreeleechDate();
            return nextFreeleech - now;
        }

        static isToday(date) {
            const today = new Date();
            return (
                date.getDate() === today.getDate() &&
                date.getMonth() === today.getMonth() &&
                date.getFullYear() === today.getFullYear()
            );
        }

        static calculateTimeUntilServerReset() {
            const now = new Date();
            const resetTime = new Date();
            resetTime.setUTCHours(Config.SERVER_TIMEZONE_OFFSET_UTC, 0, 0, 0);
            if (now > resetTime) {
                resetTime.setUTCDate(resetTime.getUTCDate() + 1);
            }
            return resetTime - now;
        }

        static calculateTimeSinceLastServerReset() {
            const now = new Date();
            const resetTime = new Date();
            resetTime.setUTCHours(Config.SERVER_TIMEZONE_OFFSET_UTC, 0, 0, 0);
            if (now < resetTime) {
                resetTime.setUTCDate(resetTime.getUTCDate() - 1);
            }
            return now - resetTime;
        }

        static getTimezoneOffsetInMinutes(timezone) {
            const date = new Date();

            // Now, get the UTC offset for the timezone by adjusting the date object
            const targetTimeZoneDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));

            // Calculate the difference in minutes from UTC
            const offsetInMinutes = targetTimeZoneDate.getMinutes() - date.getMinutes() + (targetTimeZoneDate.getHours() - date.getHours()) * 60;

            return offsetInMinutes;
        }

    }

    // ==UI Helpers==
    class UIHelpers {
        static addTorrentOpenerUI(torrents, element, legendText = null) {
            const container = document.createElement('fieldset');

            if (legendText) {
                const legend = document.createElement('legend');
                legend.innerText = legendText;
                container.appendChild(legend);
            }

            for (const [key, value] of Object.entries(torrents)) {
                const progressBarId = `progress-${Utils.toSnakeCase(Utils.trimExcessWhitespace(key))}`;
                const progressBar = UIHelpers.generateProgressBar(0, 100, null, progressBarId);

                const button = document.createElement('button');
                button.textContent = `Open "${key}" (${value.length})`;
                button.addEventListener('click', () => {
                    value.forEach((torrent, index) => {
                        setTimeout(() => {
                            const percentage = Math.floor((index + 1) / value.length * 100);
                            Utils.logDebug(`Downloading ${index + 1}/${value.length} (${percentage}%) - ${torrent.pageUrl}`);
                            GM_openInTab(torrent.pageUrl);

                            UIHelpers.updateProgressBar(progressBarId, percentage);

                            UIHelpers.markTorrentRowAsDownloaded(torrent)
                        }, index * Config.URL_DELAY);
                    });
                    UIHelpers.addProgressBarToTasksPane(`Opening torrents for "${key}"`, progressBar);
                });

                container.appendChild(button);
            }

            element.appendChild(container);
        }

        static generateBasicTable(headers, rows, tableClass = 'bCenter borderless', cellSpacing = '1') {
            const table = document.createElement('table');
            table.className = tableClass;
            table.setAttribute('cellspacing', cellSpacing);

            // Add table headers
            const headerRow = document.createElement('tr');
            headerRow.className = 'row3';
            headers.forEach((headerText, index) => {
                const headerCell = document.createElement('th');
                headerCell.innerHTML = `<font style="vertical-align: inherit;">${headerText}</font>`;
                headerCell.style.cursor = 'pointer';
                headerCell.addEventListener('click', () => this.sortTable(table, index));
                headerRow.appendChild(headerCell);
            });
            table.appendChild(headerRow);

            // Add rows
            rows.forEach((rowData, index) => {
                const row = document.createElement('tr');
                row.className = index % 2 === 0 ? 'row1' : 'row5';

                rowData.forEach(cellData => {
                    const cell = document.createElement('td');
                    cell.innerHTML = `<font style="vertical-align: inherit;">${cellData}</font>`;
                    row.appendChild(cell);
                });

                table.appendChild(row);
            });

            return table;
        }

        static sortTable(table, columnIndex) {
            const rows = Array.from(table.rows).slice(1);
            const isNumericColumn = !isNaN(rows[0].cells[columnIndex].innerText.trim());
            const headerCell = table.rows[0].cells[columnIndex];
            const isAscending = headerCell.getAttribute('data-sort') !== 'asc';

            rows.sort((a, b) => {
                const aText = a.cells[columnIndex].innerText.trim();
                const bText = b.cells[columnIndex].innerText.trim();

                if (isNumericColumn) {
                    return isAscending ? parseFloat(aText) - parseFloat(bText) : parseFloat(bText) - parseFloat(aText);
                } else {
                    return isAscending ? aText.localeCompare(bText) : bText.localeCompare(aText);
                }
            });

            // Re-append sorted rows to the table
            rows.forEach(row => table.appendChild(row));

            // Update sort direction attribute and indicator
            Array.from(table.rows[0].cells).forEach(cell => {
                cell.removeAttribute('data-sort');
            });
            headerCell.setAttribute('data-sort', isAscending ? 'asc' : 'desc');
        }

        static generateTorrentsTable(torrents, type) {
            if (torrents.length === 0) {
                const noTorrentsFound = document.createElement('p');
                noTorrentsFound.textContent = 'No torrents found.';
                return noTorrentsFound;
            }

            const headers = ['Title', 'Size', 'Topic', type === 'downloaded' ? 'Download Date' : 'Saved Date', 'Actions'];
            const rows = torrents.map(torrent => [
                `<a href="${torrent.pageUrl}" target="_blank">${torrent.title}</a>`,
                torrent.size,
                torrent.topic?.title || 'Unknown',
                type === 'downloaded' ? torrent.downloadDate || 'Unknown' : torrent.savedDate || 'Unknown',
                `<button class="delete-torrent" data-id="${torrent.id}">Delete</button>`
            ]);

            const table = this.generateBasicTable(headers, rows);
            const profile = StorageManager.loadProfile();

            // Add event listeners for delete buttons
            table.querySelectorAll('.delete-torrent').forEach(button => {
                button.addEventListener('click', (event) => {
                    const target = event.currentTarget;
                    const torrentId = target.getAttribute('data-id');
                    const row = target.closest('tr');
                    row.remove();

                    if (type === 'downloaded') {
                        profile.removeDownloadedTorrent(torrentId);
                    } else {
                        profile.removeTorrentFromList(torrentId);
                    }
                    StorageManager.saveProfile(profile);
                });
            });


            return table;
        }

        static generateDownloadedTorrentsTable(torrents) {
            const container = document.createElement('div');
            const clearButton = document.createElement('button');
            clearButton.textContent = 'Clear Downloaded Torrents';
            clearButton.style.color = 'red';
            clearButton.addEventListener('click', () => {
                if (confirm('Are you sure you want to clear all downloaded torrents?')) {
                    const profile = StorageManager.loadProfile();
                    profile.downloadedTorrents = [];
                    StorageManager.saveProfile(profile);
                    container.innerHTML = ''; // Clear the container
                    container.appendChild(clearButton); // Re-add the clear button
                    container.appendChild(this.generateTorrentsTable([], 'downloaded'));
                }
            });
            container.appendChild(this.generateTorrentsTable(torrents, 'downloaded'));
            container.appendChild(clearButton);

            container.classList.add('active-torrents-list');
            return container;
        }

        static generateSavedTorrentsTable(torrents) {
            const container = document.createElement('div');
            const clearButton = document.createElement('button');
            clearButton.textContent = 'Clear Saved Torrents';
            clearButton.style.color = 'red';
            clearButton.addEventListener('click', () => {
                if (confirm('Are you sure you want to clear all saved torrents?')) {
                    const profile = StorageManager.loadProfile();
                    profile.torrentList = [];
                    StorageManager.saveProfile(profile);
                    container.innerHTML = ''; // Clear the container
                    container.appendChild(clearButton); // Re-add the clear button
                    container.appendChild(this.generateTorrentsTable([], 'saved'));
                }
            });
            container.appendChild(this.generateTorrentsTable(torrents, 'saved'));
            container.appendChild(clearButton);

            container.classList.add('active-torrents-list');
            return container;
        }

        static generateStatsPanel(profile, nextRatio) {
            const statsContainer = document.createElement('div');
            statsContainer.className = 'stats-panel';

            statsContainer.innerHTML = `
            <p class="cat">Ratio stats</p>
            <p>Uploaded: ${Utils.formatBytes(profile.stats.uploaded)}</p>
            <p>Downloaded: ${Utils.formatBytes(profile.stats.downloaded)}</p>
            <p>Next Ratio: ${nextRatio.nextRatio}</p>
            <p>Upload needed for next ratio: ${nextRatio.requiredUpload}</p>
            <p class="cat">Script stats</p>
            <p>Torrents downloaded (via script): ${profile.downloadedTorrents.length}</p>
            <p>Torrents saved (via script): ${profile.torrentList.length}</p>
            <p>Quota remaining: ${QuotaManager.calculateRemainingQuota(profile)}</p>
            <p>Last updated: ${profile.stats.lastUpdated}</p>
            <p>Current ratio: ${profile.stats.ratio}</p>

        `;

            return statsContainer;
        }

        static generateCountdownPanel(targetTime, showTargetDate = false, countdownLabelText = "Time remaining:", id = null) {
            const countdownContainer = document.createElement('div');
            countdownContainer.className = 'countdown-panel';

            if (id) {
                countdownContainer.id = id;
            }

            const countdownLabel = document.createElement('p');
            countdownLabel.textContent = countdownLabelText; // Use the custom text here
            countdownContainer.appendChild(countdownLabel);

            const countdownTime = document.createElement('span');
            countdownContainer.appendChild(countdownTime);

            // Optional: Display the target date if `showTargetDate` is true
            if (showTargetDate) {
                const targetDateLabel = document.createElement('p');
                targetDateLabel.textContent = `Target Date: ${targetTime.toLocaleString()}`;
                countdownContainer.appendChild(targetDateLabel);
            }

            // Set an interval to update the countdown every second
            setInterval(() => {
                const currentTime = new Date();
                const timeRemaining = targetTime - currentTime;

                if (timeRemaining <= 0) {
                    countdownTime.textContent = "00:00:00";
                } else {
                    countdownTime.textContent = Utils.formatCountdown(timeRemaining);
                }
            }, 1000);

            return countdownContainer;
        }

        static generateProgressBar(progress, max = 100, label = "", id = null) {
            const progressBarContainer = document.createElement('div');
            progressBarContainer.className = 'progress-bar-container';

            if (id) {
                progressBarContainer.id = id;
            }

            if (label) {
                const progressLabel = document.createElement('p');
                progressLabel.textContent = label;
                progressBarContainer.appendChild(progressLabel);
            }

            // Progress bar wrapper (background color for start and end visibility)
            const progressBarWrapper = document.createElement('div');
            progressBarWrapper.className = 'progress-bar-wrapper';
            progressBarContainer.appendChild(progressBarWrapper);

            // Progress bar (foreground color, dynamic width)
            const progressBar = document.createElement('div');
            progressBar.className = 'progress-bar';
            const percentage = Math.round((progress / max) * 100);
            progressBar.style.width = `${percentage}%`;

            // Create a span to show the percentage inside the progress bar
            const progressValue = document.createElement('span');
            progressValue.className = 'progress-bar-value';
            progressValue.textContent = `${percentage}%`;

            // Append the progress value span inside the progress bar
            progressBar.appendChild(progressValue);

            // Append the progress bar to the wrapper
            progressBarWrapper.appendChild(progressBar);

            // Hide the progress bar container by default (can be made visible later)
            progressBarContainer.style.display = 'none';

            return progressBarContainer;
        }

        static addProgressBarToTasksPane(taskName, progressBar) {
            const tasksPane = document.getElementById('tasks-pane');
            if (tasksPane.style.display === 'none') {
                this.togglePaneVisibility(tasksPane);
            }

            const taskContainer = document.createElement('div');
            taskContainer.className = 'task-container';

            const taskLabel = document.createElement('p');
            taskLabel.textContent = taskName;
            taskContainer.appendChild(taskLabel);

            taskContainer.appendChild(progressBar);
            tasksPane.appendChild(taskContainer);
            tasksPane.style.display = 'block'; // Ensure the pane is visible when a task is added
        }

        static checkAndCloseTasksPane() {
            const tasksPane = document.getElementById('tasks-pane');
            const taskContainers = tasksPane.querySelectorAll('.task-container');
            const allTasksCompleted = Array.from(taskContainers).every(container => {
                const progressBar = container.querySelector('.progress-bar');
                return progressBar.style.width === '100%';
            });

            if (allTasksCompleted) {
                this.togglePaneVisibility(tasksPane);
            }
        }

        static updateProgressBar(id, percentage) {
            const progressBar = document.getElementById(id);
            progressBar.style.display = 'block';
            progressBar.querySelector('div.progress-bar').style.width = `${percentage}%`;
            progressBar.querySelector('span.progress-bar-value').innerText = `${percentage}%`;

            if (percentage === 100) {
                this.checkAndCloseTasksPane();
            }
        }

        static createHeaderSection() {
            const headerSection = document.createElement('div');
            headerSection.id = 'plhelper-header-section';
            headerSection.style.display = 'flex';
            headerSection.style.flexDirection = 'column';
            headerSection.style.alignItems = 'center';
            headerSection.style.marginBottom = '10px';
            document.getElementById('logo').appendChild(headerSection);
        }

        static showFreeleechCountdown() {
            const isFreeleech = TimeHelpers.isToday(TimeHelpers.getNextFreeLeechTime());
            let targetTime;
            if (isFreeleech) {
                targetTime = new Date(Date.now() + TimeHelpers.calculateTimeUntilServerReset());
            } else {
                targetTime = new Date(TimeHelpers.getNextFreeLeechTime());
            }

            const countdownPanel = UIHelpers.generateCountdownPanel(
                targetTime,
                !isFreeleech,
                isFreeleech ? "Freeleech active! Ending in:" : "Time until next freeleech:",
                "freeleech-countdown"
            );

            countdownPanel.classList.add('thHead');

            if (isFreeleech) {
                countdownPanel.style.background = 'rgb(34,193,195)';
                countdownPanel.style.background = 'radial-gradient(circle, rgba(34,193,195,1) 0%, rgba(253,187,45,1) 100%)';
            }

            document.getElementById('plhelper-header-section').appendChild(countdownPanel);
        }

        static showRemainingDownloads(profile) {
            const remainingQuota = QuotaManager.calculateRemainingQuota(profile);
            const downloadsRemainingElement = document.createElement('p');

            downloadsRemainingElement.innerText = `Downloads remaining: ${remainingQuota}`;
            downloadsRemainingElement.style.color = remainingQuota <= 0 ? 'red' : (remainingQuota < 10 ? 'orange' : 'green');
            downloadsRemainingElement.classList.add('cat');

            document.getElementById('plhelper-header-section').appendChild(downloadsRemainingElement);
        }

        static markPageAsDownloaded(isDownloaded) {
            const container = document.querySelector('.post_body');
            const torReged = document.querySelectorAll('#tor-reged td');
            const bgColor = isDownloaded ? 'crimson' : 'darkseagreen';
            const txtColor = isDownloaded ? 'white' : 'black';

            // Check if elements exist before trying to modify their styles
            if (container) {
                container.style.backgroundColor = bgColor;
                container.style.color = txtColor;
            }

            torReged.forEach((el) => {
                el.style.background = bgColor;
                el.style.color = txtColor;
        });
        }

        static markTorrentRowAsDownloaded(torrent) {
            const torrentLinkElement = document.querySelector(`a[href="./viewtopic.php?t=${torrent.id}"]`);
            const fullRowElement = torrentLinkElement?.parentNode?.parentNode?.parentNode;
            torrentLinkElement.style.textDecoration = 'line-through';
            if (fullRowElement) {
                fullRowElement.style.textDecoration = 'line-through';
                fullRowElement.style.opacity = '.5';
            }
        }

        static addToggleButton(targetElement, buttonText = 'Toggle') {
            const button = document.createElement('button');
            button.textContent = buttonText;
            button.addEventListener('click', () => {
                if (targetElement.style.display === 'none') {
                    targetElement.style.display = 'block';
                } else {
                    targetElement.style.display = 'none';
                }
            });
            return button;
        }

        static createPane(id, titleText, position = { top: '10px', right: '10px' }) {
            const pane = document.createElement('div');
            pane.id = id;
            pane.className = 'fade';
            pane.style.position = 'fixed';
            pane.style.top = position.top;
            pane.style.right = position.right;
            pane.style.backgroundColor = 'white';
            pane.style.border = '1px solid black';
            pane.style.padding = '10px';
            pane.style.zIndex = '1000';
            pane.style.display = 'none';

            const title = document.createElement('h3');
            title.classList.add('thHead');
            title.textContent = titleText;
            pane.appendChild(title);

            document.body.appendChild(pane);
            return pane;
        }

        static togglePaneVisibility(pane) {
            if (pane.style.display === 'none') {
                pane.style.display = 'block';
                setTimeout(() => pane.classList.add('show'), 10);
            } else {
                pane.classList.remove('show');
                setTimeout(() => pane.style.display = 'none', 500);
            }
        }

        static createBackgroundTasksPane() {
            const tasksPane = this.createPane('tasks-pane', 'Background Tasks', { top: '10px', left: '10px' });
            tasksPane.style.display = 'none';
        }
    };

    // ==Page Handlers==
    class TrackerHelpers {
        static getTrackerTopicList() {
            if (!Utils.checkPage('tracker_page')) {
                console.error('Unable to fetch topic ids from current page!');
                return
            }

            const topics = [];
            document.querySelectorAll('#fs-main option').forEach((option) => {
                if (option.value) {
                    topics.push(new TorrentTopic(option.value, option.textContent.trim()));
                }
            });

            return topics;
        }

        // This function returns a list op tracker topics filtered by either an array of ids or an array of titles.
        // If no filter is provided, it returns all topics.
        static getFilteredTrackerTopicIds(filter = null) {
            const topics = this.getTrackerTopicList();
            if (!filter) return topics;
            if (Array.isArray(filter)) {
                return topics.filter(topic => filter.some(f => topic.id === f || topic.title.includes(f)));
            } else {
                console.error('Invalid filter type. Expected an array.');
                return [];
            }
        }
    }
    class PageHandlers {
        static handleProfilePage(profile) {
            const wrapper = document.querySelector(SELECTORS.profilePage);
            if (!wrapper) return;

            try {
                profile.updateStatsFromProfilePage();
                if (profile.passKey !== undefined && document.querySelector('#passkey-val').innerText !== profile.passKey) {
                    if (!confirm("Different passkey detected, please verify if you have the correct user logged in. If not, please log in with the correct user. Do you want to update the passkey?")) {
                        return;
                    }
                }
                profile.passKey = document.querySelector('#passkey-val').innerText;
            } catch (error) {
                console.error('Error updating profile stats:', error);
            }
            // Render downloaded torrents table
            const torrentsTable = UIHelpers.generateDownloadedTorrentsTable(profile.downloadedTorrents);
            torrentsTable.style.display = 'none'; // Initially hide the table
            const toggleButton = UIHelpers.addToggleButton(torrentsTable, 'Show/Hide downloaded torrents');

            // Render torrent list table
            const torrentList = profile.torrentList;
            const torrentListTable = UIHelpers.generateSavedTorrentsTable(torrentList);
            torrentListTable.style.display = 'none'; // Initially hide the table
            const toggleListButton = UIHelpers.addToggleButton(torrentListTable, 'Show/Hide torrent list');

            wrapper.appendChild(toggleButton);
            wrapper.appendChild(toggleListButton);
            wrapper.appendChild(torrentsTable);
            wrapper.appendChild(torrentListTable);

            // Calculate next ratio and required upload
            const nextRatio = Utils.calculateNextRatio(profile.stats.ratio);
            const requiredUpload = Utils.formatBytes(profile.calculateRequiredUpload(nextRatio));

            Utils.logDebug('Next ratio and upload requirements:', {
                nextRatio,
                requiredUpload,
                stats: profile.stats
            });

            // Render stats panel
            const statsPanel = UIHelpers.generateStatsPanel(profile, {
                nextRatio,
                requiredUpload
            });
            document.getElementById('u_ratio').appendChild(statsPanel);

            // Save updated profile
            StorageManager.saveProfile(profile);
        }

        static handleTrackerPage(profile) {
            const rows = document.querySelectorAll(SELECTORS.trackerPageRows);
            const allTorrents = Array.from(rows)
                .map(row => TorrentMapper.mapTrackerToTorrent(row, profile))
                .filter(Boolean);

            // Load preferred formats from settings
            const settings = StorageManager.loadSettings();
            const preferredFormats = settings.preferredFormats;

            const filteredTorrentsByFormat = preferredFormats.reduce((acc, format) => {
                // Filter torrents by checking if the format exists in the title
                acc[format] = allTorrents.filter(torrent => torrent.title.includes(format));
                return acc;
            }, {});

            // Add torrents that don't match any preferred format to the "undefined format" category
            filteredTorrentsByFormat["Unknown Format"] = allTorrents.filter(torrent =>
                !Config.AVAILABLE_VIDEO_FORMATS.some(format => torrent.title.includes(format))
            );

            // Fetch all topics and map them to TorrentTopic instances
            const topicElements = document.querySelectorAll("#tor-tbl > tbody > tr > td:nth-child(3) > a");
            const torrentTopics = Array.from(topicElements).map(el => {
                const topicUrl = el?.href;
                const topicId = Utils.parseIdFromUrl(topicUrl, 'topic');
                const topicTitle = el?.textContent.trim();
                return new TorrentTopic(topicId, topicTitle, topicUrl);
            });

            // Create a map of filtered torrents grouped by topic title
            const filteredTorrentsByTopic = torrentTopics.reduce((acc, topic) => {
                // Filter torrents by the current topic's ID
                acc[topic.title] = allTorrents.filter(torrent => {
                    const hasPreferredFormat = preferredFormats.some(format => torrent.title.includes(format));
                    const isMatchingTopic = torrent.topic?.id === topic.id;

                    // Include torrents with preferred formats or unknown formats
                    return isMatchingTopic && (hasPreferredFormat || !Config.AVAILABLE_VIDEO_FORMATS.some(format => torrent.title.includes(format)));
                });
                return acc;
            }, {});


            // Create details element with name "batch open torrents" and add both UI openers to that one.
            const batchOpenWrapper = document.createElement('details');
            batchOpenWrapper.classList.add('fieldsets');
            batchOpenWrapper.style.backgroundColor = '#B7C0C5';

            // Use the saved setting to determine the initial state
            if (settings.batchOpenerState) {
                batchOpenWrapper.setAttribute('open', '');
            }

            batchOpenWrapper.id = Config.ELEMENT_NAME_PREFIX + 'batch-opener';
            const batchOpenSummary = document.createElement('summary');
            batchOpenSummary.textContent = 'Batch open torrents';
            batchOpenWrapper.appendChild(batchOpenSummary);
            batchOpenWrapper.appendChild(document.createElement('hr'));
            document.querySelector("#main_content_wrap > table > tbody > tr:nth-child(1) > td:nth-child(1)").prepend(batchOpenWrapper);

            UIHelpers.addTorrentOpenerUI(filteredTorrentsByFormat, batchOpenWrapper, "Video Format");
            UIHelpers.addTorrentOpenerUI(filteredTorrentsByTopic, batchOpenWrapper, "Topic");
        }

        static handleFormPage(profile) {
            const rows = document.querySelectorAll(SELECTORS.formPageRows);
            const torrents = Array.from(rows)
                .map(row => TorrentMapper.mapFormPostToTorrent(row, profile))
                .filter(Boolean);

            // Add torrent opener UI
            const selector = document.querySelector("#main_content_wrap > table:nth-child(6)");
            UIHelpers.addTorrentOpenerUI({ torrents }, selector, 'topic selectors');
        }

        static handleTorrentPage(profile) {
            // Parse torrent data.
            const torrentId = Utils.parseIdFromUrl(location.search, 'torrent');
            const torrentTitle = document.querySelector(SELECTORS.torrentPageTitle)?.textContent?.trim();
            const torrentUrl = location.href;
            const torrentSize = document.querySelector(SELECTORS.torrentPageSize)?.textContent;

            const topicElement = document.querySelector(SELECTORS.torrentPageTopic);
            const topicUrl = topicElement?.href;
            const topicId = Utils.parseIdFromUrl(topicUrl, 'topic');
            const topicTitle = topicElement?.textContent;
            const torrentTopic = new TorrentTopic(topicId, topicTitle, topicUrl);

            const torrent = new Torrent(torrentId, torrentTitle, torrentUrl, torrentSize, torrentTopic);

            // Update UI based on whether the torrent is downloaded
            UIHelpers.markPageAsDownloaded(torrent.isDownloaded(profile.downloadedTorrents));

            // Add event listener to download button
            const downloadButton = document.querySelector(SELECTORS.downloadButton);
            if (downloadButton) {
                downloadButton.addEventListener('click', (e) => {
                    // Fetch profile again, in case other tab modified it
                    profile = StorageManager.loadProfile();

                    torrent.downloadDate = new Date().toString();
                    if (torrent.isDownloaded(profile.downloadedTorrents)) {
                        const downloadConfirmed = confirm('Torrent is already downloaded. Download anyway?');

                        if (!downloadConfirmed) {
                            e.preventDefault();
                            Utils.logDebug("Download prevented - Torrent already downloaded!");
                            return;
                        }
                    }
                    // Add the torrent and save the profile
                    profile.addDownloadedTorrent(torrent);
                    StorageManager.saveProfile(profile);
                    UIHelpers.markPageAsDownloaded(true);

                    // TODO: Add ability to check if download succeeded. If not, don't add to profile/remove from list.

                    // Update the counter for downloaded torrents
                    const downloadsRemainingElement = document.querySelector('#plhelper-header-section p.cat');
                    if (downloadsRemainingElement) {
                        const remainingQuota = QuotaManager.calculateRemainingQuota(profile);
                        downloadsRemainingElement.innerText = `Downloads remaining: ${remainingQuota}`;
                        downloadsRemainingElement.style.color = remainingQuota <= 0 ? 'red' : (remainingQuota < 10 ? 'orange' : 'green');
                    }
                });
            }

            // Add button to toggle torrent in the list
            const addButton = document.createElement('button');

            let isInList = profile.torrentList.some(t => t.id === torrent.id);
            addButton.textContent = isInList ? 'Remove from List' : 'Add to List';

            addButton.addEventListener('click', () => {
                // Fetch profile again to prevent overwriting
                profile = StorageManager.loadProfile();
                isInList = profile.torrentList.some(t => t.id === torrent.id);
                if (isInList) {
                    profile.removeTorrentFromList(torrent.id);
                    addButton.textContent = 'Add to List';
                    alert('Torrent removed from list!');
                } else {
                    torrent.savedDate = new Date().toString();
                    profile.addTorrentToList(torrent);
                    addButton.textContent = 'Remove from List';
                    alert('Torrent added to list!');
                }
                StorageManager.saveProfile(profile);
            });

            document.querySelector(SELECTORS.torrentPageTitle).appendChild(addButton);
        }
    };

    // ==Settings Pane==
    class SettingsPane {
        static createSettingsPane() {
            const settingsPane = UIHelpers.createPane('settings-pane', 'Settings', { top: '30px', right: '10px' });

            // Add warning message
            const warningMessage = document.createElement('p');
            warningMessage.textContent = 'Warning: Changes will not take effect until you click the "Save" button!';
            warningMessage.style.color = 'red';
            warningMessage.style.fontWeight = 'bold';
            warningMessage.style.display = 'none'; // Initially hidden
            settingsPane.appendChild(warningMessage);

            // Video Formats Fieldset
            const videoFormatsFieldset = document.createElement('fieldset');
            const videoFormatsLegend = document.createElement('legend');
            videoFormatsLegend.textContent = 'Preferred Video Formats';
            videoFormatsFieldset.appendChild(videoFormatsLegend);

            const videoFormatsContainer = document.createElement('div');
            Config.AVAILABLE_VIDEO_FORMATS.forEach(format => {
                const formatLabel = document.createElement('label');
                const formatInput = document.createElement('input');
                formatInput.type = 'checkbox';
                formatInput.name = 'videoFormat';
                formatInput.value = format;

                formatLabel.appendChild(formatInput);
                formatLabel.appendChild(document.createTextNode(format));
                videoFormatsContainer.appendChild(formatLabel);
                videoFormatsContainer.appendChild(document.createElement('br'));
            });
            videoFormatsFieldset.appendChild(videoFormatsContainer);
            settingsPane.appendChild(videoFormatsFieldset);

            // General Settings Fieldset
            const generalSettingsFieldset = document.createElement('fieldset');
            const generalSettingsLegend = document.createElement('legend');
            generalSettingsLegend.textContent = 'General Settings';
            generalSettingsFieldset.appendChild(generalSettingsLegend);

            // Hide Downloaded Torrents
            const hideDownloadedLabel = document.createElement('label');
            hideDownloadedLabel.textContent = 'Hide Downloaded Torrents';
            const hideDownloadedInput = document.createElement('input');
            hideDownloadedInput.type = 'checkbox';
            hideDownloadedInput.name = 'hideDownloadedTorrents';
            generalSettingsFieldset.appendChild(hideDownloadedInput);
            generalSettingsFieldset.appendChild(hideDownloadedLabel);

            // Batch Opener State
            const batchOpenerLabel = document.createElement('label');
            batchOpenerLabel.textContent = 'Show Batch Opener';
            const batchOpenerInput = document.createElement('input');
            batchOpenerInput.type = 'checkbox';
            batchOpenerInput.name = 'batchOpenerState';
            generalSettingsFieldset.appendChild(batchOpenerInput);
            generalSettingsFieldset.appendChild(batchOpenerLabel);

            settingsPane.appendChild(generalSettingsFieldset);

            // Add event listeners to inputs to show the warning when changes are made
            const inputs = settingsPane.querySelectorAll('input');
            inputs.forEach(input => {
                input.addEventListener('change', () => {
                    warningMessage.style.display = 'block';
                });
            });

            // Load saved settings
            const savedSettings = StorageManager.loadSettings();
            savedSettings.preferredFormats.forEach(format => {
                const selectedOption = Array.from(videoFormatsContainer.querySelectorAll('input')).find(input => input.value === format);
                if (selectedOption) {
                    selectedOption.checked = true;
                }
            });
            hideDownloadedInput.checked = savedSettings.hideDownloadedTorrents;
            batchOpenerInput.checked = savedSettings.batchOpenerState;

            const buttonContainer = document.createElement('div');
            buttonContainer.classList.add('cat');
            settingsPane.appendChild(buttonContainer);

            // Save button
            const saveButton = document.createElement('button');
            saveButton.textContent = 'Save';
            saveButton.addEventListener('click', () => {
                const selectedFormats = Array.from(videoFormatsContainer.querySelectorAll('input[name="videoFormat"]:checked')).map(input => input.value);
                const newSettings = {
                    ...savedSettings,
                    preferredFormats: selectedFormats,
                    hideDownloadedTorrents: hideDownloadedInput.checked,
                    batchOpenerState: batchOpenerInput.checked
                };
                StorageManager.saveSettings(newSettings);
                alert('Settings saved!');
                window.location.reload(); // Reload the page after saving settings
            });
            buttonContainer.appendChild(saveButton);

            // Export button
            const exportButton = document.createElement('button');
            exportButton.textContent = 'Export Settings';
            exportButton.addEventListener('click', () => {
                StorageManager.exportTampermonkeyStorage();
            });
            buttonContainer.appendChild(exportButton);

            // Import button
            const importButton = document.createElement('button');
            importButton.textContent = 'Import Settings';
            importButton.addEventListener('click', () => {
                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = '.json';
                fileInput.addEventListener('change', StorageManager.importTampermonkeyStorage);
                fileInput.click();
            });
            buttonContainer.appendChild(importButton);

            // Reset button
            const resetButton = document.createElement('button');
            resetButton.textContent = 'Reset all data';
            resetButton.style.color = 'red';
            resetButton.addEventListener('click', () => {
                if (confirm('Are you sure you want to reset all data to default? This include torrent lists')) {
                    StorageManager.clearTampermonkeyStorage();
                    window.location.href = document.querySelector(SELECTORS.profileName).href;
                }
            });
            buttonContainer.appendChild(resetButton);

            // Toggle button for settings pane
            const toggleButton = document.createElement('button');
            toggleButton.textContent = 'Toggle PHelper Settings';
            toggleButton.style.position = 'fixed';
            toggleButton.style.top = '10px';
            toggleButton.style.right = '10px';
            toggleButton.style.zIndex = '1001';
            toggleButton.addEventListener('click', () => {
                UIHelpers.togglePaneVisibility(settingsPane);
            });
            document.body.appendChild(toggleButton);
        }
    };

    class MenuItems {
        static registerAllMenuItems() {
            GM_registerMenuCommand('Export settings', StorageManager.exportTampermonkeyStorage);
            GM_registerMenuCommand('Import settings', () => {

                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = '.json';
                fileInput.addEventListener('change', StorageManager.importTampermonkeyStorage);
                fileInput.click();

            });
            GM_registerMenuCommand('Reset all data', StorageManager.clearTampermonkeyStorage);
        }
    }

    // Add top banner for DEV mode or debug mode
    function addTopBanner() {
        const bannerContainer = document.createElement('div');
        bannerContainer.style.position = 'fixed';
        bannerContainer.style.top = '0';
        bannerContainer.style.left = '0';
        bannerContainer.style.width = '100%';
        bannerContainer.style.zIndex = '10000';
        bannerContainer.style.textAlign = 'center';
        bannerContainer.style.padding = '10px';
        bannerContainer.style.fontWeight = 'bold';
        bannerContainer.style.color = 'white';

        if (/dev/i.test(GM_info.script.version)) {
            const devBanner = document.createElement('div');
            devBanner.textContent = 'DEV MODE ACTIVE';
            devBanner.style.backgroundColor = 'red';
            bannerContainer.appendChild(devBanner);
        }

        if (Config.DEBUG_MODE) {
            const debugBanner = document.createElement('div');
            debugBanner.textContent = 'DEBUG MODE ENABLED';
            debugBanner.style.backgroundColor = 'orange';
            bannerContainer.appendChild(debugBanner);
        }

        if (bannerContainer.children.length > 0) {
            document.body.style.marginTop = `${bannerContainer.offsetHeight}px`; // Adjust page margin
            document.body.prepend(bannerContainer);
        }
    }

    // ==Main==
    function initializeScript() {
        try {
            addTopBanner();
            const profile = StorageManager.loadProfile();
            const profileLink = document.querySelector(SELECTORS.profileName);
            if (profileLink && profileLink.href.includes('register')) {
                Utils.logDebug('Unable to run properly as user is not logged in. Setting stats update to bad value to trigger update.');
                profile.stats.lastUpdated = null;
                StorageManager.saveProfile(profile);
                return;
            }

            if (profile.version === undefined) {
                if (ProfileMigration.isLegacyProfile(profile)) {
                    // Migrating old 1.X data to newest 2.X data structure.
                    Utils.logDebug("Legacy profile detected. Migrating...");
                    const newProfile = ProfileMigration.convertOldProfileToNew(profile);
                    StorageManager.clearTampermonkeyStorage();
                    StorageManager.saveProfile(newProfile);
                    window.location.reload();
                    return;
                }
            }

            if (profile.version !== scriptVersion) {
                Utils.logDebug(`Version changed from ${profile.version} to ${scriptVersion}. Performing necessary updates.`);
                profile.version = scriptVersion;
                StorageManager.saveProfile(profile)
            }

            const lastServerReset = TimeHelpers.calculateTimeSinceLastServerReset();
            if (new Date(profile.stats.lastUpdated) < lastServerReset && !Utils.checkPage('profile_page')) {
                alert('Profile stats are outdated. Please visit your profile page to update the stats.');
                window.location.href = document.querySelector(SELECTORS.profileName).href;
                return;
            }

            if (Utils.checkPage('profile_page')) {
                PageHandlers.handleProfilePage(profile);
            } else if (Utils.checkPage('tracker_page')) {
                PageHandlers.handleTrackerPage(profile);
            } else if (Utils.checkPage('topic_page')) {
                PageHandlers.handleTorrentPage(profile);
            } else if (Utils.checkPage('form_page')) {
                PageHandlers.handleFormPage(profile);
            }

            UIHelpers.createHeaderSection();
            UIHelpers.showFreeleechCountdown();
            UIHelpers.showRemainingDownloads(profile);
            SettingsPane.createSettingsPane();
            UIHelpers.createBackgroundTasksPane();

            MenuItems.registerAllMenuItems();
        } catch (error) {
            console.error('Error initializing script:', error);
            alert('An error occurred while initializing the script. Please check the console for details.');
        }
    }

    initializeScript();
})();
